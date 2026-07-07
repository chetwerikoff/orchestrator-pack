/**
 * Spawn-owned worktree grant validation (Issue #470).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  classifySpawnAction,
  gitArgvSubcommandIndex,
  parseClaimPrNumberFromSpawnArgv,
  parseStrictPositiveIntegerToken,
} from './autonomous-orchestrator-boundary.mjs';
import {
  evaluateSpawnClaimPrPostCheckout,
  evaluateSpawnWorktreeHeadRefAuthorization,
  resolveGitCommitRefInRepo,
  resolveSpawnDefaultBranchBaseRef,
} from './spawn-worktree-git-ref.mjs';
import { readStdinJson, runStdinJsonCli } from './review-mechanical-cli.mjs';

export const SPAWN_WORKTREE_GRANT_SCHEMA_VERSION = 1;
export const SPAWN_WORKTREE_GRANT_TTL_SECONDS = 120;
/** Bounded same-lineage worktree-add retries before terminal finalization failure (#567). */
export const SPAWN_WORKTREE_GRANT_MAX_FINALIZATION_ATTEMPTS = 3;

/** Grant-boundary reasons that must not be misclassified as GitHub auth failures (#567). */
export const SPAWN_WORKTREE_GRANT_BOUNDARY_REASONS = new Set([
  'grant_missing',
  'grant_schema_mismatch',
  'grant_already_consumed',
  'grant_expired',
  'grant_reserve_path_mismatch',
  'grant_finalization_attempts_exhausted',
  'grant_finalize_path_mismatch',
  'grant_finalize_worktree_not_durable',
  'grant_repository_unbound',
  'grant_pr_missing',
  'grant_issue_missing',
  'grant_action_invalid',
  'git_source_global_denied',
  'missing_path',
  'missing_explicit_commit',
  'path_unresolvable',
  'path_escape',
  'target_preexists',
  'basename_mismatch',
  'repository_root_unresolvable',
  'repository_identity_mismatch',
  'head_ref_mismatch',
  'branch_mismatch',
  'spawn_worktree_allow',
  'spawn_worktree_idempotent',
]);

/** AO worker session worktree basenames allocated by @aoagents/ao-plugin-workspace-worktree. */
export const AO_SPAWN_WORKTREE_SESSION_BASENAME_PATTERN = /^opk-\d+$/i;

/** Git globals that select a repository other than the process cwd. */
export const GIT_SOURCE_SELECTING_GLOBAL_FLAGS = new Set(['-C', '--git-dir', '--work-tree']);

/** `ao spawn` flags that consume the next argv token (see `ao spawn --help`, AO 0.10.2). */
export const SPAWN_ARGV_OPTIONS_WITH_VALUE = [
  '--agent',
  '--claim-pr',
  '--issue',
  '--name',
  '--project',
  '--prompt',
];

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
 * @returns {number | null}
 */
export function parseIssueNumberFromSpawnArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token === '--issue' && index + 1 < list.length) {
      return parseStrictPositiveIntegerToken(list[index + 1]);
    }
    const eqMatch = /^--issue=(.+)$/i.exec(token);
    if (eqMatch) {
      return parseStrictPositiveIntegerToken(eqMatch[1]);
    }
  }
  return null;
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
  const issueNumber = parseIssueNumberFromSpawnArgv(list);
  if (issueNumber === null) {
    return { action, targetKey: '', prNumber: null, issueTarget: null };
  }
  const issueToken = String(issueNumber);
  return {
    action,
    targetKey: issueToken,
    prNumber: null,
    issueTarget: issueToken,
  };
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
 * Resolve shared git repository identity for spawn-grant repository binding (#511).
 *
 * @param {string} cwd
 */
export function resolveGitRepositoryIdentity(cwd) {
  const workDir = String(cwd ?? '').trim();
  if (!workDir) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  try {
    const commonDirRel = execFileSync('git', ['-C', workDir, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!commonDirRel) {
      return { ok: false, reason: 'repository_root_unresolvable' };
    }
    const showToplevel = execFileSync('git', ['-C', workDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const commonDirAbs = path.isAbsolute(commonDirRel)
      ? commonDirRel
      : path.resolve(workDir, commonDirRel);
    if (!existsSync(commonDirAbs)) {
      return { ok: false, reason: 'repository_root_unresolvable' };
    }
    let identity = commonDirAbs;
    try {
      identity = typeof realpathSync.native === 'function'
        ? realpathSync.native(commonDirAbs)
        : realpathSync(commonDirAbs);
    }
    catch {
      identity = realpathSync(commonDirAbs);
    }
    return {
      ok: true,
      identity: String(identity).replace(/[/\\]+$/, ''),
      showToplevel: String(showToplevel).trim(),
      gitCommonDirRaw: commonDirRel,
    };
  }
  catch {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
}

/**
 * @param {string} left
 * @param {string} right
 */
/**
 * Resolve the mint/consume cwd git worktree root used for ref/OID resolution (#511).
 *
 * @param {string} cwd
 */
export function resolveGitWorktreeRoot(cwd) {
  const workDir = String(cwd ?? '').trim();
  if (!workDir) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  try {
    const showToplevel = execFileSync('git', ['-C', workDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!showToplevel) {
      return { ok: false, reason: 'repository_root_unresolvable' };
    }
    let worktreeRoot = showToplevel;
    try {
      worktreeRoot = typeof realpathSync.native === 'function'
        ? realpathSync.native(showToplevel)
        : realpathSync(showToplevel);
    }
    catch {
      worktreeRoot = realpathSync(showToplevel);
    }
    return {
      ok: true,
      worktreeRoot: String(worktreeRoot).replace(/[/\\]+$/, ''),
    };
  }
  catch {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
}

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
 * @param {string} root
 */
function normalizeRepositoryIdentityForCompare(root) {
  const resolved = resolveGitRepositoryIdentity(root);
  if (resolved.ok) {
    return { ok: true, identity: resolved.identity };
  }
  const candidate = String(root ?? '').trim().replace(/[/\\]+$/, '');
  if (!candidate || !existsSync(candidate)) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  const normalized = candidate.replace(/\\/g, '/');
  const base = path.basename(candidate);
  if (base !== '.git' && !normalized.includes('/.git/')) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  try {
    const identity = typeof realpathSync.native === 'function'
      ? realpathSync.native(candidate)
      : realpathSync(candidate);
    return { ok: true, identity: String(identity).replace(/[/\\]+$/, '') };
  }
  catch {
    return { ok: true, identity: candidate };
  }
}

/**
 * Compare grant-bound and effective repository roots, accepting legacy
 * worktree-root grants minted before shared-identity binding (#511).
 *
 * @param {string} grantRoot
 * @param {string} effectiveRoot
 */
export function spawnGrantRepositoryRootsEqual(grantRoot, effectiveRoot) {
  const grant = String(grantRoot ?? '').trim();
  const effective = String(effectiveRoot ?? '').trim();
  if (!grant || !effective) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  if (canonicalRepositoryRootsEqual(grant, effective)) {
    return { ok: true };
  }
  const grantIdentity = normalizeRepositoryIdentityForCompare(grant);
  const effectiveIdentity = normalizeRepositoryIdentityForCompare(effective);
  if (!grantIdentity.ok && !effectiveIdentity.ok) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  if (!grantIdentity.ok) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  if (!effectiveIdentity.ok) {
    return { ok: false, reason: 'repository_root_mismatch' };
  }
  if (!canonicalRepositoryRootsEqual(grantIdentity.identity, effectiveIdentity.identity)) {
    return { ok: false, reason: 'repository_root_mismatch' };
  }
  return { ok: true };
}

/**
 * @param {string[]} argv
 */
export function parseGitSpawnWorktreeAddArgv(argv) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const index = gitArgvSubcommandIndex(list);
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
 * @param {string} basename
 */
export function isAoSpawnWorktreeSessionBasename(basename) {
  return AO_SPAWN_WORKTREE_SESSION_BASENAME_PATTERN.test(String(basename ?? ''));
}

/**
 * Basename authorization for spawn grant consume. Mint-time exact names remain
 * allowed; AO session ids (opk-<digits>) are accepted under active grant lineage.
 *
 * @param {string} basename
 * @param {string[]} allowedNames
 */
export function evaluateSpawnWorktreeBasenameBinding(basename, allowedNames) {
  const name = String(basename ?? '');
  if (!name) {
    return { ok: false, reason: 'worktree_session_basename_invalid' };
  }
  if (allowedNames.includes(name)) {
    return { ok: true, reason: 'mint_authorized_name' };
  }
  if (isAoSpawnWorktreeSessionBasename(name)) {
    return { ok: true, reason: 'ao_session_basename' };
  }
  return { ok: false, reason: 'worktree_session_basename_invalid' };
}


/**
 * @param {string} left
 * @param {string} right
 */
export function spawnWorktreeCanonicalPathsEqual(left, right) {
  const a = String(left ?? '').trim();
  const b = String(right ?? '').trim();
  if (!a || !b) {
    return false;
  }
  return path.resolve(a) === path.resolve(b);
}

/**
 * @param {Record<string, unknown>} grant
 */
export function spawnWorktreeGrantReservedPath(grant) {
  const reserved = grant?.worktreeAllowReserved;
  if (!reserved || typeof reserved !== 'object') {
    return '';
  }
  return String(/** @type {{ worktreeCanonicalPath?: string }} */ (reserved).worktreeCanonicalPath ?? '').trim();
}

/**
 * @param {Record<string, unknown>} grant
 */
export function spawnWorktreeGrantReservedAttemptCount(grant) {
  const reserved = grant?.worktreeAllowReserved;
  if (!reserved || typeof reserved !== 'object') {
    return 0;
  }
  const count = Number(/** @type {{ attemptCount?: number }} */ (reserved).attemptCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * @param {object} input
 */
export function classifySpawnWorktreeGrantFailureDiagnosis(input) {
  const boundaryReason = String(input.boundaryReason ?? '').trim();
  const githubReadsSucceeded = Boolean(input.githubReadsSucceeded);
  const stderr = String(input.stderr ?? '');
  if (
    githubReadsSucceeded
    && boundaryReason
    && SPAWN_WORKTREE_GRANT_BOUNDARY_REASONS.has(boundaryReason)
  ) {
    return {
      kind: 'spawn_grant_finalization',
      reason: boundaryReason,
      misclassifiedAsGhAuth: /gh auth|GitHub CLI is not authenticated/i.test(stderr),
    };
  }
  if (/gh auth|GitHub CLI is not authenticated/i.test(stderr)) {
    return { kind: 'github_auth', reason: 'github_auth_failure' };
  }
  return { kind: 'unknown', reason: boundaryReason || 'boundary_reason_missing' };
}

/**
 * @param {object} input
 */
/**
 * Verify a reserved/consumed path is a durable AO worktree for the grant (#567).
 *
 * @param {object} input
 */
export function evaluateSpawnWorktreePathDurable(input) {
  const canonicalPath = String(input.canonicalPath ?? '').trim();
  const grant = input.grant ?? null;

  if (!canonicalPath) {
    return { ok: false, durable: false, reason: 'path_unresolvable' };
  }
  if (!existsSync(canonicalPath)) {
    return { ok: true, durable: false, reason: 'path_missing' };
  }
  try {
    const inside = execFileSync('git', ['-C', canonicalPath, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (inside !== 'true') {
      return { ok: true, durable: false, reason: 'not_git_worktree' };
    }
  }
  catch {
    return { ok: true, durable: false, reason: 'not_git_worktree' };
  }

  if (!grant || typeof grant !== 'object') {
    return { ok: true, durable: false, reason: 'grant_missing' };
  }

  const grantRepo = String(grant.sourceRepositoryRoot ?? '').trim();
  if (!grantRepo) {
    return { ok: true, durable: false, reason: 'grant_repository_unbound' };
  }

  const targetIdentity = resolveGitRepositoryIdentity(canonicalPath);
  if (!targetIdentity.ok) {
    return { ok: true, durable: false, reason: 'repository_root_unresolvable' };
  }

  const repoBinding = spawnGrantRepositoryRootsEqual(grantRepo, targetIdentity.identity ?? '');
  if (!repoBinding.ok) {
    return { ok: true, durable: false, reason: repoBinding.reason ?? 'repository_root_mismatch' };
  }

  const expectedCommitOid = String(
    grant.normalizedCommitOid ?? grant.expectedCommitOid ?? '',
  ).trim();
  const headAuth = evaluateSpawnWorktreeHeadRefAuthorization({
    repoRoot: grantRepo,
    expectedRepoRoot: grantRepo,
    actualRepoRoot: canonicalPath,
    expectedRefToken: String(grant.expectedHeadRef ?? 'HEAD'),
    expectedCommitOid,
    actualRefToken: 'HEAD',
  });
  if (!headAuth.ok) {
    return { ok: true, durable: false, reason: headAuth.reason ?? 'head_oid_mismatch' };
  }

  return { ok: true, durable: true, reason: 'spawn_worktree_durable' };
}

export function evaluateSpawnWorktreeGrantConsume(input) {
  const grant = input.grant ?? null;
  const argv = Array.isArray(input.argv) ? input.argv.map((part) => String(part)) : [];
  const canonicalPath = String(input.canonicalPath ?? '');
  const worktreesPrefix = String(input.worktreesPrefix ?? '');
  const targetPreexists = Boolean(input.targetPreexists);
  const worktreeDurable = Boolean(input.worktreeDurable);
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();

  if (!grant || typeof grant !== 'object') {
    return { ok: false, reason: 'grant_missing' };
  }
  if (Number(grant.schemaVersion) !== SPAWN_WORKTREE_GRANT_SCHEMA_VERSION) {
    return { ok: false, reason: 'grant_schema_mismatch' };
  }
  if (grant.consumed) {
    const consumedPathEarly = String(grant.consumedCanonicalPath ?? '').trim();
    if (consumedPathEarly && !spawnWorktreeCanonicalPathsEqual(consumedPathEarly, canonicalPath)) {
      return { ok: false, reason: 'grant_already_consumed' };
    }
  }
  const reservedPath = spawnWorktreeGrantReservedPath(grant);
  if (reservedPath && !spawnWorktreeCanonicalPathsEqual(reservedPath, canonicalPath)) {
    return { ok: false, reason: 'grant_reserve_path_mismatch' };
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
  if (targetPreexists && !reservedPath) {
    return { ok: false, reason: 'target_preexists' };
  }

  const basename = canonicalPath.split(/[/\\]/).pop() ?? '';
  const allowedNames = Array.isArray(grant.authorizedWorktreeNames)
    ? grant.authorizedWorktreeNames.map((name) => String(name))
    : [];
  const basenameBinding = evaluateSpawnWorktreeBasenameBinding(basename, allowedNames);
  if (!basenameBinding.ok) {
    return { ok: false, reason: basenameBinding.reason };
  }

  const grantRepo = String(grant.sourceRepositoryRoot ?? '').trim();
  if (!grantRepo) {
    return { ok: false, reason: 'grant_repository_unbound' };
  }
  const effectiveRepo = String(input.effectiveRepositoryRoot ?? '').trim();
  if (!effectiveRepo) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  const repoBinding = spawnGrantRepositoryRootsEqual(grantRepo, effectiveRepo);
  if (!repoBinding.ok) {
    return { ok: false, reason: repoBinding.reason };
  }

  const grantRefRepo = String(grant.sourceGitWorktreeRoot ?? grant.sourceRepositoryRoot ?? '').trim();
  const effectiveRefRepo = String(input.effectiveGitWorktreeRoot ?? '').trim();
  if (!grantRefRepo || !effectiveRefRepo) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }

  const headAuth = evaluateSpawnWorktreeHeadRefAuthorization({
    repoRoot: grantRefRepo,
    expectedRepoRoot: grantRefRepo,
    actualRepoRoot: effectiveRefRepo,
    expectedRefToken: String(grant.expectedHeadRef ?? 'HEAD'),
    expectedCommitOid: grant.expectedCommitOid ? String(grant.expectedCommitOid) : '',
    actualRefToken: String(shape.commit),
  });
  if (!headAuth.ok) {
    return {
      ok: false,
      reason: headAuth.reason,
      expectedRefToken: headAuth.expectedRefToken,
      expectedCommitOid: headAuth.expectedCommitOid,
      actualRefToken: headAuth.actualRefToken,
      actualCommitOid: headAuth.actualCommitOid,
    };
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

  if (shape.branch) {
    const branchBinding = evaluateSpawnWorktreeBranchBinding(shape.branch, grant);
    if (!branchBinding.ok) {
      return { ok: false, reason: branchBinding.reason };
    }
  }

  const headRefAudit = {
    expectedRefToken: headAuth.expectedRefToken,
    expectedCommitOid: headAuth.expectedCommitOid,
    actualRefToken: headAuth.actualRefToken,
    actualCommitOid: headAuth.actualCommitOid,
    normalizationMode: headAuth.normalizationMode,
    sourceRepositoryRoot: grantRepo,
    action: String(grant.action ?? ''),
    grantId: String(grant.grantId ?? ''),
  };
  if (grant.consumed) {
    const consumedPath = String(grant.consumedCanonicalPath ?? '').trim();
    if (
      consumedPath
      && spawnWorktreeCanonicalPathsEqual(consumedPath, canonicalPath)
      && worktreeDurable
    ) {
      return {
        ok: true,
        reason: 'spawn_worktree_idempotent',
        idempotent: true,
        consumedCanonicalPath: consumedPath,
        headRefAudit,
      };
    }
    return { ok: false, reason: 'grant_already_consumed' };
  }
  if (reservedPath && worktreeDurable) {
    return {
      ok: true,
      reason: 'spawn_worktree_idempotent',
      idempotent: true,
      requiresFinalize: true,
      basename,
      commit: shape.commit,
      normalizedCommitOid: headAuth.normalizedCommitOid,
      normalizationMode: headAuth.normalizationMode,
      reservedCanonicalPath: reservedPath,
      headRefAudit,
    };
  }

  if (reservedPath) {
    const attemptCount = spawnWorktreeGrantReservedAttemptCount(grant);
    if (attemptCount >= SPAWN_WORKTREE_GRANT_MAX_FINALIZATION_ATTEMPTS) {
      return { ok: false, reason: 'grant_finalization_attempts_exhausted' };
    }
  }

  return {
    ok: true,
    reason: 'spawn_worktree_allow',
    basename,
    commit: shape.commit,
    normalizedCommitOid: headAuth.normalizedCommitOid,
    normalizationMode: headAuth.normalizationMode,
    reservedAttemptCount: reservedPath ? spawnWorktreeGrantReservedAttemptCount(grant) + 1 : 1,
    headRefAudit,
  };
}

/**
 * Commit terminal consumed state only after durable worker worktree creation (#567).
 *
 * @param {object} input
 */
export function evaluateSpawnWorktreeGrantFinalize(input) {
  const grant = input.grant ?? null;
  const canonicalPath = String(input.canonicalPath ?? '').trim();
  const worktreeDurable = Boolean(input.worktreeDurable);

  if (!grant || typeof grant !== 'object') {
    return { ok: false, reason: 'grant_missing' };
  }
  if (Number(grant.schemaVersion) !== SPAWN_WORKTREE_GRANT_SCHEMA_VERSION) {
    return { ok: false, reason: 'grant_schema_mismatch' };
  }
  if (!canonicalPath) {
    return { ok: false, reason: 'path_unresolvable' };
  }
  if (grant.consumed) {
    const consumedPath = String(grant.consumedCanonicalPath ?? '').trim();
    if (consumedPath && spawnWorktreeCanonicalPathsEqual(consumedPath, canonicalPath)) {
      return { ok: true, reason: 'grant_finalize_idempotent', consumedCanonicalPath: consumedPath };
    }
    return { ok: false, reason: 'grant_already_consumed' };
  }
  const reservedPath = spawnWorktreeGrantReservedPath(grant);
  if (!reservedPath || !spawnWorktreeCanonicalPathsEqual(reservedPath, canonicalPath)) {
    return { ok: false, reason: 'grant_finalize_path_mismatch' };
  }
  if (!worktreeDurable) {
    return { ok: false, reason: 'grant_finalize_worktree_not_durable' };
  }
  return {
    ok: true,
    reason: 'grant_finalize_commit',
    consumedCanonicalPath: canonicalPath,
  };
}


/**
 * @param {import('./spawn-worktree-grant.d.mts').SpawnTargetParse} parsed
 * @param {string[]} [extraAuthorizedWorktreeNames]
 */
export function deriveSpawnAuthorizedWorktreeNames(parsed, extraAuthorizedWorktreeNames = []) {
  const authorized = new Set();
  if (parsed.issueTarget) {
    const issueTarget = String(parsed.issueTarget);
    authorized.add(issueTarget);
    if (!/^opk-/i.test(issueTarget)) {
      authorized.add(`opk-${issueTarget}`);
    }
  }
  if (parsed.prNumber !== null) {
    authorized.add(`pr-${parsed.prNumber}`);
  }
  for (const name of extraAuthorizedWorktreeNames) {
    if (name) {
      authorized.add(String(name));
    }
  }
  return [...authorized];
}

/**
 * Worker branch spellings bound to spawn lineage (#561). Issue-linked branches
 * cover AO production `feat/issue-<N>` / `feat/<N>` shapes; session branches
 * reuse claim-pr owner session ids carried in extraAuthorizedWorktreeNames.
 *
 * @param {import('./spawn-worktree-grant.d.mts').SpawnTargetParse} parsed
 * @param {string[]} [extraAuthorizedWorktreeNames]
 * @param {string[]} [extraAuthorizedWorkerBranches]
 */
export function deriveSpawnAuthorizedWorkerBranches(
  parsed,
  extraAuthorizedWorktreeNames = [],
  extraAuthorizedWorkerBranches = [],
) {
  const authorized = new Set();
  if (parsed.issueTarget) {
    const issue = String(parsed.issueTarget);
    authorized.add(`feat/issue-${issue}`);
    authorized.add(`feat/${issue}`);
    if (/^\d+$/.test(issue)) {
      authorized.add(`opk-${issue}`);
    }
  }
  for (const name of extraAuthorizedWorktreeNames) {
    const value = String(name ?? '').trim();
    if (value && isAoSpawnWorktreeSessionBasename(value)) {
      authorized.add(value);
    }
  }
  for (const name of extraAuthorizedWorkerBranches) {
    const value = String(name ?? '').trim();
    if (value) {
      authorized.add(value);
    }
  }
  return [...authorized];
}

/**
 * Branch operand authorization for production-shaped `git worktree add -b`.
 *
 * @param {string} branch
 * @param {Record<string, unknown>} grant
 */
export function evaluateSpawnWorktreeBranchBinding(branch, grant) {
  const branchStr = String(branch ?? '').trim();
  if (!branchStr) {
    return { ok: false, reason: 'branch_missing' };
  }
  const allowed = new Set();
  if (grant.expectedBranch) {
    allowed.add(String(grant.expectedBranch));
  }
  if (Array.isArray(grant.authorizedWorkerBranches)) {
    for (const name of grant.authorizedWorkerBranches) {
      if (name) {
        allowed.add(String(name));
      }
    }
  }
  if (allowed.size === 0) {
    return { ok: false, reason: 'branch_mismatch' };
  }
  if (allowed.has(branchStr)) {
    return { ok: true, reason: 'authorized_worker_branch' };
  }
  return { ok: false, reason: 'branch_mismatch' };
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
  const sourceGitWorktreeRoot = String(
    input.sourceGitWorktreeRoot ?? input.sourceRepositoryRoot ?? '',
  ).trim();
  if (!sourceGitWorktreeRoot) {
    return { ok: false, reason: 'source_git_worktree_missing' };
  }
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const expiresAtUtc = new Date(nowMs + SPAWN_WORKTREE_GRANT_TTL_SECONDS * 1000).toISOString();
  const extraWorktreeNames = Array.isArray(input.extraAuthorizedWorktreeNames)
    ? input.extraAuthorizedWorktreeNames
    : [];
  const authorized = deriveSpawnAuthorizedWorktreeNames(parsed, extraWorktreeNames);
  const authorizedWorkerBranches = deriveSpawnAuthorizedWorkerBranches(
    parsed,
    extraWorktreeNames,
    Array.isArray(input.extraAuthorizedWorkerBranches) ? input.extraAuthorizedWorkerBranches : [],
  );
  const expectedHeadRef = String(input.expectedHeadRef ?? 'HEAD');
  let expectedCommitOid = String(input.expectedCommitOid ?? '').trim().toLowerCase();
  if (!expectedCommitOid) {
    const resolved = resolveGitCommitRefInRepo(sourceGitWorktreeRoot, expectedHeadRef);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }
    expectedCommitOid = resolved.commitOid;
  }
  /** @type {Record<string, unknown>} */
  const grant = {
    schemaVersion: SPAWN_WORKTREE_GRANT_SCHEMA_VERSION,
    grantId: String(input.grantId ?? ''),
    action: parsed.action,
    projectId: String(input.projectId ?? 'orchestrator-pack'),
    targetKey: parsed.targetKey,
    issueTarget: parsed.issueTarget,
    prNumber: parsed.prNumber,
    authorizedWorktreeNames: [...authorized],
    authorizedWorkerBranches: [...authorizedWorkerBranches],
    expectedHeadRef,
    expectedCommitOid,
    expectedBranch: input.expectedBranch
      ? String(input.expectedBranch)
      : (authorizedWorkerBranches[0] ?? null),
    sourceRepositoryRoot,
    sourceGitWorktreeRoot,
    mintedAtUtc: new Date(nowMs).toISOString(),
    expiresAtUtc,
    consumed: false,
    holder: input.holder ?? null,
  };
  if (parsed.action === 'claim-pr-resume') {
    const expectedPrHeadOid = String(input.expectedPrHeadOid ?? '').trim().toLowerCase();
    if (!expectedPrHeadOid) {
      return { ok: false, reason: 'expected_pr_head_missing' };
    }
    grant.expectedPrHeadOid = expectedPrHeadOid;
    if (input.expectedPrRefToken) {
      grant.expectedPrRefToken = String(input.expectedPrRefToken);
    }
  }
  return {
    ok: true,
    reason: 'grant_built',
    grant,
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
  evaluatePathDurable: () => evaluateSpawnWorktreePathDurable(readStdinJson()),
  evaluateConsume: () => evaluateSpawnWorktreeGrantConsume(readStdinJson()),
  evaluateFinalize: () => evaluateSpawnWorktreeGrantFinalize(readStdinJson()),
  classifyFailureDiagnosis: () => classifySpawnWorktreeGrantFailureDiagnosis(readStdinJson()),
  evaluateBoundaryEscape: () => evaluateBoundaryEscapeSignal(readStdinJson()),
  resolveDefaultBranchBaseRef: () => {
    const input = readStdinJson();
    return resolveSpawnDefaultBranchBaseRef(
      String(input.repoRoot ?? ''),
      String(input.defaultBranch ?? 'main'),
      Boolean(input.fixtureMode),
    );
  },
  resolveCommitRef: () => {
    const input = readStdinJson();
    return resolveGitCommitRefInRepo(String(input.repoRoot ?? ''), String(input.refToken ?? ''));
  },
  evaluateHeadRefAuthorization: () => evaluateSpawnWorktreeHeadRefAuthorization(readStdinJson()),
  evaluateClaimPrPostCheckout: () => evaluateSpawnClaimPrPostCheckout(readStdinJson()),
  resolveRepositoryIdentity: () => {
    const input = readStdinJson();
    return resolveGitRepositoryIdentity(String(input.cwd ?? ''));
  },
  resolveGitWorktreeRoot: () => {
    const input = readStdinJson();
    return resolveGitWorktreeRoot(String(input.cwd ?? ''));
  },
});
