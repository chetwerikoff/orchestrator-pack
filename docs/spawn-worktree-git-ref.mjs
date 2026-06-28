/**
 * Repo-bound git commit ref resolution for spawn worktree grants (Issue #493).
 */
import { execFileSync } from 'node:child_process';
import { gitArgvSubcommandIndex } from './autonomous-orchestrator-boundary.mjs';

const FULL_OID = /^[0-9a-f]{40}$/i;
const SHORT_OID = /^[0-9a-f]{4,39}$/i;

/**
 * @param {string} repoRoot
 * @param {string[]} gitArgs
 */
function runGitInRepo(repoRoot, gitArgs) {
  return execFileSync('git', ['-C', repoRoot, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * @param {unknown} value
 */
function normalizeRepoRoot(value) {
  return String(value ?? '').trim().replace(/[/\\]+$/, '');
}

/**
 * @param {unknown} value
 */
function normalizeRefToken(value) {
  return String(value ?? '').trim();
}


/**
 * Resolve AO 0.9.x default-branch worktree-add base ref preference.
 *
 * @param {string} repoRoot
 * @param {string} [defaultBranch]
 * @param {boolean} [fixtureMode]
 */
export function resolveSpawnDefaultBranchBaseRef(repoRoot, defaultBranch = 'main', fixtureMode = false) {
  const repo = normalizeRepoRoot(repoRoot);
  const branch = String(defaultBranch ?? 'main').trim() || 'main';
  if (!repo) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }
  const originRef = `origin/${branch}`;
  try {
    runGitInRepo(repo, ['rev-parse', '--verify', `${originRef}^{commit}`]);
    return { ok: true, refToken: originRef };
  }
  catch {
    const localRef = `refs/heads/${branch}`;
    try {
      runGitInRepo(repo, ['rev-parse', '--verify', `${localRef}^{commit}`]);
      return { ok: true, refToken: localRef };
    }
    catch {
      if (fixtureMode) {
        try {
          runGitInRepo(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
          return { ok: true, refToken: 'HEAD' };
        }
        catch {
          return { ok: false, reason: 'default_branch_base_ref_unresolvable' };
        }
      }
      return { ok: false, reason: 'default_branch_base_ref_unresolvable' };
    }
  }
}

/**
 * @param {string} message
 */
function classifyGitRevParseFailure(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.includes('ambiguous argument') || text.includes('short object id')) {
    return 'head_ref_ambiguous';
  }
  if (text.includes('not a committish') || text.includes('not a commit') || text.includes('blob type') || text.includes('tree type')) {
    return 'head_ref_not_commit';
  }
  if (text.includes('needed a single revision') || text.includes('bad revision')) {
    return 'head_ref_unresolvable';
  }
  return 'head_ref_unresolvable';
}

/**
 * Resolve a ref token to a peeled commit OID inside an explicit repository.
 *
 * @param {string} repoRoot
 * @param {string} refToken
 */
export function resolveGitCommitRefInRepo(repoRoot, refToken) {
  const repo = normalizeRepoRoot(repoRoot);
  const ref = normalizeRefToken(refToken);
  if (!repo || !ref) {
    return { ok: false, reason: 'head_ref_unresolvable' };
  }

  try {
    const peeled = runGitInRepo(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    const full = runGitInRepo(repo, ['rev-parse', peeled]).trim().toLowerCase();
    if (!FULL_OID.test(full)) {
      return { ok: false, reason: 'head_ref_not_commit' };
    }
    return { ok: true, commitOid: full, refToken: ref };
  }
  catch (error) {
    const errObj = error && typeof error === 'object' ? error : {};
    const stderr = String(errObj.stderr ?? '');
    const stdout = String(errObj.stdout ?? '');
    const output = Array.isArray(errObj.output)
      ? errObj.output.map((part) => String(part ?? '')).join('\n')
      : '';
    const message = `${stderr}\n${stdout}\n${output}\n${error instanceof Error ? error.message : String(error)}`;

    if (SHORT_OID.test(ref)) {
      try {
        runGitInRepo(repo, ['rev-parse', '--verify', '--end-of-options', ref]);
        return { ok: false, reason: 'head_ref_ambiguous' };
      }
      catch (inner) {
        const innerMessage = inner instanceof Error ? inner.message : String(inner);
        if (String(innerMessage).toLowerCase().includes('ambiguous')) {
          return { ok: false, reason: 'head_ref_ambiguous' };
        }
      }
    }

    return { ok: false, reason: classifyGitRevParseFailure(message) };
  }
}

/**
 * @param {string} left
 * @param {string} right
 */
export function commitOidsEqual(left, right) {
  const a = String(left ?? '').trim().toLowerCase();
  const b = String(right ?? '').trim().toLowerCase();
  if (!FULL_OID.test(a) || !FULL_OID.test(b)) {
    return false;
  }
  return a === b;
}

/**
 * @param {object} input
 */
export function evaluateSpawnWorktreeHeadRefAuthorization(input) {
  const fallbackRepoRoot = normalizeRepoRoot(input.repoRoot);
  const expectedRepoRoot = normalizeRepoRoot(input.expectedRepoRoot ?? input.repoRoot);
  const actualRepoRoot = normalizeRepoRoot(input.actualRepoRoot ?? input.repoRoot);
  const expectedRefToken = normalizeRefToken(input.expectedRefToken);
  const actualRefToken = normalizeRefToken(input.actualRefToken);
  const expectedCommitOid = String(input.expectedCommitOid ?? '').trim().toLowerCase();

  if (!fallbackRepoRoot || !expectedRepoRoot || !actualRepoRoot) {
    return { ok: false, reason: 'repository_root_unresolvable' };
  }

  const expectedResolved = expectedCommitOid && FULL_OID.test(expectedCommitOid)
    ? { ok: true, commitOid: expectedCommitOid, refToken: expectedRefToken || expectedCommitOid }
    : resolveGitCommitRefInRepo(expectedRepoRoot, expectedRefToken);
  if (!expectedResolved.ok) {
    return { ok: false, reason: expectedResolved.reason };
  }

  const actualResolved = resolveGitCommitRefInRepo(actualRepoRoot, actualRefToken);
  if (!actualResolved.ok) {
    return { ok: false, reason: actualResolved.reason };
  }

  if (!commitOidsEqual(expectedResolved.commitOid, actualResolved.commitOid)) {
    return {
      ok: false,
      reason: 'head_oid_mismatch',
      expectedRefToken: expectedRefToken || expectedCommitOid,
      expectedCommitOid: expectedResolved.commitOid,
      actualRefToken,
      actualCommitOid: actualResolved.commitOid,
    };
  }

  return {
    ok: true,
    reason: 'head_ref_oid_allow',
    expectedRefToken: expectedRefToken || expectedCommitOid,
    expectedCommitOid: expectedResolved.commitOid,
    actualRefToken,
    actualCommitOid: actualResolved.commitOid,
    normalizedCommitOid: actualResolved.commitOid,
    normalizationMode: 'verified_full_oid',
  };
}

/**
 * @param {object} input
 */
export function evaluateSpawnClaimPrPostCheckout(input) {
  const repoRoot = normalizeRepoRoot(input.workspaceRoot);
  const expectedPrHeadOid = String(input.expectedPrHeadOid ?? '').trim().toLowerCase();
  const prNumber = Number(input.prNumber);
  const prRefToken = normalizeRefToken(input.prRefToken);

  if (!repoRoot) {
    return { ok: false, reason: 'workspace_root_unresolvable' };
  }
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return { ok: false, reason: 'grant_pr_missing' };
  }
  if (!FULL_OID.test(expectedPrHeadOid)) {
    return { ok: false, reason: 'expected_pr_head_missing' };
  }

  const actual = resolveGitCommitRefInRepo(repoRoot, 'HEAD');
  if (!actual.ok) {
    return { ok: false, reason: 'workspace_head_unresolvable' };
  }

  if (!commitOidsEqual(expectedPrHeadOid, actual.commitOid)) {
    return {
      ok: false,
      reason: 'claim_pr_head_oid_mismatch',
      prNumber,
      prRefToken,
      expectedPrHeadOid,
      actualWorkspaceHeadOid: actual.commitOid,
    };
  }

  return {
    ok: true,
    reason: 'claim_pr_post_checkout_allow',
    prNumber,
    prRefToken,
    expectedPrHeadOid,
    actualWorkspaceHeadOid: actual.commitOid,
  };
}

/**
 * @param {string[]} argv
 * @param {string} normalizedCommitOid
 */
export function rewriteGitWorktreeAddCommitArgv(argv, normalizedCommitOid) {
  const list = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
  const oid = String(normalizedCommitOid ?? '').trim().toLowerCase();
  if (!FULL_OID.test(oid)) {
    return list;
  }

  const index = gitArgvSubcommandIndex(list);
  if (index >= list.length || list[index].toLowerCase() !== 'worktree') {
    return list;
  }
  if (index + 1 >= list.length || list[index + 1].toLowerCase() !== 'add') {
    return list;
  }

  let cursor = index + 2;
  let sawPath = false;
  while (cursor < list.length) {
    const token = list[cursor];
    if (/^--detach$/i.test(token)) {
      cursor += 1;
      continue;
    }
    if (/^(-b|--branch)$/i.test(token)) {
      cursor += 2;
      continue;
    }
    if (/^(-f|--force|--checkout|--lock|--orphan)$/i.test(token)) {
      cursor += 1;
      continue;
    }
    if (token.startsWith('-')) {
      return list;
    }
    if (!sawPath) {
      sawPath = true;
      cursor += 1;
      continue;
    }
    const rewritten = [...list];
    rewritten[cursor] = oid;
    return rewritten;
  }
  return list;
}
