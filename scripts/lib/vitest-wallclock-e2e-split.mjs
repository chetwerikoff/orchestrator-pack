#!/usr/bin/env node
/**
 * Coverage-delta and approval helpers for Issue #694 wall-clock e2e stage split.
 * Pre-move union proof derives from preMoveBaselineSha via detached git worktree (AC#2).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLanePlan, resolveRepoRoot } from './vitest-ci-lanes.mjs';

export const manifestRelPath = 'scripts/vitest-wallclock-e2e-split.manifest.json';
export const preMoveManifestRelPath = 'scripts/vitest-wallclock-e2e-split.pre-move-manifest.json';

export function loadSplitManifest(repoRoot = resolveRepoRoot()) {
  const path = join(resolveRepoRoot(repoRoot), manifestRelPath);
  if (!existsSync(path)) {
    throw new Error(`missing wall-clock split manifest: ${manifestRelPath}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadPreMoveManifest(repoRoot = resolveRepoRoot()) {
  const path = join(resolveRepoRoot(repoRoot), preMoveManifestRelPath);
  if (!existsSync(path)) {
    throw new Error(`missing pre-move manifest: ${preMoveManifestRelPath}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}


const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export function normalizeBaselineSha(sha) {
  if (typeof sha !== 'string') {
    return null;
  }
  const trimmed = sha.trim().toLowerCase();
  return FULL_SHA_RE.test(trimmed) ? trimmed : null;
}

export function gitCommitExists(commitSha, repoRoot = resolveRepoRoot()) {
  const normalized = normalizeBaselineSha(commitSha);
  if (!normalized) {
    return false;
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${normalized}^{commit}`], {
      cwd: resolveRepoRoot(repoRoot),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function withDetachedGitWorktree(repoRoot, commitSha, callback) {
  const root = resolveRepoRoot(repoRoot);
  const normalized = normalizeBaselineSha(commitSha);
  if (!normalized) {
    throw new Error('invalid baseline commit sha');
  }
  if (!gitCommitExists(normalized, root)) {
    throw new Error(`baseline commit missing: ${normalized}`);
  }
  const tempBase = mkdtempSync(join(tmpdir(), 'opk-wallclock-baseline-'));
  const worktreePath = join(tempBase, 'tree');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, normalized], {
      cwd: root,
      stdio: 'pipe',
    });
    return callback(worktreePath);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: root,
        stdio: 'ignore',
      });
    } catch {
      /* best effort */
    }
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export function derivePreMoveUnionAtBaseline(repoRoot = resolveRepoRoot(), baselineSha, options = {}) {
  const sha = normalizeBaselineSha(baselineSha);
  if (!sha) {
    return { ok: false, reason: 'pre-move-baseline-sha-invalid' };
  }
  if (!gitCommitExists(sha, repoRoot)) {
    return { ok: false, reason: `pre-move-baseline-commit-unavailable:${sha}` };
  }
  try {
    const union = withDetachedGitWorktree(repoRoot, sha, (worktreePath) => {
      const plan = buildLanePlan(worktreePath);
      if (!plan.ok) {
        throw new Error(plan.errors.join('; '));
      }
      return [...plan.light, ...plan.heavy].sort();
    });
    return { ok: true, baselineSha: sha, union, source: 'git-baseline' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `pre-move-baseline-derivation-failed:${message}` };
  }
}

export function validatePreMoveManifestAgainstBaseline(repoRoot = resolveRepoRoot(), options = {}) {
  const manifest = loadSplitManifest(repoRoot);
  const checkoutManifest = loadPreMoveManifest(repoRoot);
  const baselineSha = manifest.preMoveBaselineSha;
  const manifestBaselineSha = normalizeBaselineSha(checkoutManifest.baselineSha ?? '');
  const pinnedBaselineSha = normalizeBaselineSha(baselineSha);
  if (!pinnedBaselineSha) {
    return { ok: false, reason: 'pre-move-baseline-sha-invalid' };
  }
  if (manifestBaselineSha && manifestBaselineSha !== pinnedBaselineSha) {
    return { ok: false, reason: 'pre-move-manifest-baseline-sha-mismatch' };
  }
  const derived = derivePreMoveUnionAtBaseline(repoRoot, pinnedBaselineSha, options);
  if (!derived.ok) {
    return derived;
  }
  const manifestUnion = [...checkoutManifest.prRequiredUnion].sort();
  const immutableUnion = derived.union;
  if (manifestUnion.length !== immutableUnion.length
    || manifestUnion.some((file, index) => file !== immutableUnion[index])) {
    const manifestSet = new Set(manifestUnion);
    const immutableSet = new Set(immutableUnion);
    return {
      ok: false,
      reason: 'pre-move-manifest-baseline-mismatch',
      baselineSha: derived.baselineSha,
      missingFromManifest: immutableUnion.filter((file) => !manifestSet.has(file)),
      extraInManifest: manifestUnion.filter((file) => !immutableSet.has(file)),
    };
  }
  return {
    ok: true,
    baselineSha: derived.baselineSha,
    union: immutableUnion,
    source: 'git-baseline-validated',
  };
}


export function listPostMergeExecutionFiles(manifest = loadSplitManifest()) {
  const files = Object.values(manifest.preMoveToPostMergeMap).flat();
  return [...new Set(files)].sort();
}

export function buildCoverageDeltaReport(repoRoot = resolveRepoRoot()) {
  const manifest = loadSplitManifest(repoRoot);
  const baselineValidation = validatePreMoveManifestAgainstBaseline(repoRoot);
  const plan = buildLanePlan(repoRoot);
  if (!plan.ok) {
    return { ok: false, errors: plan.errors };
  }

  const postMergeExecution = listPostMergeExecutionFiles(manifest);
  const prRetained = [...plan.light, ...plan.heavy].sort();
  const parked = [...(plan.parked ?? [])].sort();
  const discovered = [...plan.discovered].sort();
  const discoveredActive = discovered.filter((file) => !parked.includes(file));
  const errors = [];

  if (!baselineValidation.ok) {
    if (baselineValidation.reason === 'pre-move-manifest-baseline-mismatch') {
      errors.push('pre-move manifest does not match pinned baseline derivation (mutable checkout rejected)');
      if (baselineValidation.missingFromManifest?.length) {
        errors.push(`pre-move manifest missing baseline files: ${baselineValidation.missingFromManifest.join(', ')}`);
      }
      if (baselineValidation.extraInManifest?.length) {
        errors.push(`pre-move manifest extra vs baseline: ${baselineValidation.extraInManifest.join(', ')}`);
      }
    } else {
      errors.push(`pre-move baseline validation failed: ${baselineValidation.reason}`);
    }
    return {
      ok: false,
      errors,
      report: {
        issue: manifest.issue,
        charterIssue: manifest.charterIssue,
        preMoveBaselineSha: manifest.preMoveBaselineSha,
        preMoveUnionCount: baselineValidation.union?.length ?? null,
        discoveredCount: discovered.length,
      },
    };
  }

  const movedEnumerated = [...manifest.preMoveEnumeratedFiles].sort();
  if (movedEnumerated.length !== 6) {
    errors.push(`preMoveEnumeratedFiles must list exactly six logical files (got ${movedEnumerated.length})`);
  }

  for (const file of postMergeExecution) {
    if (!discovered.includes(file)) {
      errors.push(`post-merge execution file missing from discovery: ${file}`);
    }
    if (plan.config.classification[file] !== 'postMergeWallclock') {
      errors.push(`post-merge execution file must be classified postMergeWallclock: ${file}`);
    }
    if (prRetained.includes(file)) {
      errors.push(`post-merge execution file still in PR lanes: ${file}`);
    }
  }

  for (const file of prRetained) {
    if (postMergeExecution.includes(file)) {
      errors.push(`PR-retained file overlaps post-merge execution set: ${file}`);
    }
    const lane = plan.config.classification[file];
    if (lane !== 'light' && lane !== 'heavy') {
      errors.push(`PR-retained file has invalid lane ${lane}: ${file}`);
    }
  }

  const union = [...new Set([...prRetained, ...postMergeExecution])].sort();
  if (union.length !== discoveredActive.length) {
    const missing = discoveredActive.filter((file) => !union.includes(file));
    const extra = union.filter((file) => !discoveredActive.includes(file));
    if (missing.length > 0) {
      errors.push(`coverage gap — discovered files not in PR ∪ post-merge: ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      errors.push(`coverage duplicate/extra — files not in discovery: ${extra.join(', ')}`);
    }
  }

  const preMoveUnion = [...baselineValidation.union].sort();
  const expectedPostMoveUnion = [...prRetained, ...postMergeExecution].sort();
  if (preMoveUnion.length !== expectedPostMoveUnion.length
    || preMoveUnion.some((file, index) => file !== expectedPostMoveUnion[index])) {
    errors.push(
      'post-move PR ∪ post-merge execution does not match pinned pre-move PR-required union',
    );
  }

  const mappedExecution = new Set(listPostMergeExecutionFiles(manifest));
  for (const [logical, successors] of Object.entries(manifest.preMoveToPostMergeMap)) {
    for (const successor of successors) {
      if (!mappedExecution.has(successor)) {
        errors.push(`successor ${successor} of ${logical} missing from post-merge execution set`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    report: {
      issue: manifest.issue,
      charterIssue: manifest.charterIssue,
      preMoveBaselineSha: manifest.preMoveBaselineSha,
      movedEnumerated,
      postMergeExecution,
      prRetained,
      prRetainedCount: prRetained.length,
      postMergeExecutionCount: postMergeExecution.length,
      preMoveUnionCount: preMoveUnion.length,
      discoveredCount: discovered.length,
    },
  };
}

const AUTHORIZED_COLLABORATOR_PERMISSIONS = new Set(['write', 'maintain', 'admin']);

export function isAuthorizedCollaboratorPermission(permission) {
  return typeof permission === 'string' && AUTHORIZED_COLLABORATOR_PERMISSIONS.has(permission);
}

export function isApprovedReviewState(state) {
  return state === 'APPROVED';
}

/**
 * Validate approval body names the marker and every enumerated logical move file.
 */
export function validateApprovalBody(body, manifest = loadSplitManifest()) {
  const text = String(body ?? '');
  const errors = [];
  if (!text.includes(manifest.approvalMarker)) {
    errors.push('missing-marker');
  }
  for (const file of manifest.preMoveEnumeratedFiles) {
    const quoted = `\`${file}\``;
    if (!text.includes(quoted)) {
      errors.push(`missing-quoted-enumerated-file:${file}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function buildGithubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubGetJson(url, token) {
  const res = await fetch(url, { headers: buildGithubHeaders(token) });
  if (!res.ok) {
    return { ok: false, status: res.status, data: null };
  }
  return { ok: true, status: res.status, data: await res.json() };
}

export function parsePullRequestNumberFromEnv(env = process.env) {
  const direct = env.GITHUB_EVENT_PULL_REQUEST_NUMBER ?? env.GITHUB_HEAD_REF?.match(/^\d+$/)?.[0];
  if (direct) {
    return String(direct);
  }
  const refMatch = String(env.GITHUB_REF ?? '').match(/^refs\/pull\/(\d+)\//);
  return refMatch?.[1] ?? null;
}

async function fetchPullRequestAuthor(owner, name, prNumber, token) {
  if (!prNumber) {
    return null;
  }
  const result = await githubGetJson(
    `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`,
    token,
  );
  if (!result.ok) {
    return null;
  }
  return result.data?.user?.login ?? null;
}

export async function fetchCollaboratorPermission(owner, name, login, token) {
  if (!login) {
    return null;
  }
  const result = await githubGetJson(
    `https://api.github.com/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`,
    token,
  );
  if (!result.ok) {
    return null;
  }
  return result.data?.permission ?? null;
}

export async function listWriteCollaboratorLogins(owner, name, token) {
  const logins = [];
  let page = 1;
  while (page <= 10) {
    const result = await githubGetJson(
      `https://api.github.com/repos/${owner}/${name}/collaborators?per_page=100&page=${page}`,
      token,
    );
    if (!result.ok) {
      return { ok: false, reason: `collaborators-fetch-failed:${result.status}` };
    }
    const batch = Array.isArray(result.data) ? result.data : [];
    if (batch.length === 0) {
      break;
    }
    for (const collaborator of batch) {
      const login = collaborator?.login;
      if (!login || isAutomationLogin(login)) {
        continue;
      }
      const permission = collaborator?.permissions?.admin
        ? 'admin'
        : collaborator?.permissions?.maintain
          ? 'maintain'
          : collaborator?.permissions?.push
            ? 'write'
            : collaborator?.permissions?.triage
              ? 'triage'
              : collaborator?.permissions?.pull
                ? 'read'
                : collaborator?.role_name;
      if (isAuthorizedCollaboratorPermission(permission)) {
        logins.push(login);
      }
    }
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }
  return { ok: true, logins };
}

export async function hasEligibleNonAuthorReviewer(owner, name, token, prAuthor) {
  const listed = await listWriteCollaboratorLogins(owner, name, token);
  if (!listed.ok) {
    return listed;
  }
  const eligible = listed.logins.filter((login) => login !== prAuthor);
  return { ok: true, eligible };
}

function isAutomationLogin(login) {
  return !login || login.endsWith('[bot]');
}

async function validateApprovalAuthor({
  owner,
  name,
  login,
  token,
  prAuthor,
  sourceKind,
}) {
  if (isAutomationLogin(login)) {
    return { ok: false, reason: 'automation-login-rejected' };
  }
  const permission = await fetchCollaboratorPermission(owner, name, login, token);
  if (!isAuthorizedCollaboratorPermission(permission)) {
    return { ok: false, reason: `unauthorized-reviewer:${login}` };
  }
  // PR author cannot satisfy the relocation gate via PR review (#694 / #487 AC#8).
  if (prAuthor && login === prAuthor && sourceKind === 'pr-review') {
    return { ok: false, reason: 'same-pr-self-created-approval-rejected' };
  }
  // Issue-comment approvals require a distinct write+ reviewer when one exists.
  if (prAuthor && login === prAuthor && sourceKind === 'issue-comment') {
    const eligible = await hasEligibleNonAuthorReviewer(owner, name, token, prAuthor);
    if (!eligible.ok) {
      return { ok: false, reason: eligible.reason };
    }
    if (eligible.eligible.length > 0) {
      return { ok: false, reason: 'same-pr-self-created-approval-rejected' };
    }
    return { ok: true, permission, soloMaintainerCarveOut: true };
  }
  return { ok: true, permission };
}

/**
 * Resolve immutable GitHub approval for relocating PR-required coverage (#487 AC#8).
 * Fixture override: OPK_WALLCLOCK_SPLIT_APPROVAL_FIXTURE=approved|missing|self-created
 */

async function fetchIssueCommentById(owner, name, commentId, token) {
  const result = await githubGetJson(
    `https://api.github.com/repos/${owner}/${name}/issues/comments/${commentId}`,
    token,
  );
  if (!result.ok) {
    return { ok: false, reason: `pinned-comment-fetch-failed:${result.status}` };
  }
  return { ok: true, comment: result.data };
}

/**
 * Resolve architect approval via pinned immutable GitHub issue-comment id (#487 AC#8).
 * Pinned refs are validated live on GitHub; PR scan still rejects self-authored comments.
 */
export async function resolvePinnedImmutableApproval(manifest, owner, name, token, options = {}) {
  const pin = manifest.immutableApprovalCommentRef;
  if (!pin || pin.commentId == null) {
    return { ok: false, reason: 'pinned-approval-ref-missing' };
  }
  if (Number(pin.issueNumber) !== Number(manifest.approvalIssue)) {
    return { ok: false, reason: 'pinned-approval-issue-mismatch' };
  }
  const fetched = await fetchIssueCommentById(owner, name, pin.commentId, token);
  if (!fetched.ok) {
    return { ok: false, source: 'live', reason: fetched.reason };
  }
  const comment = fetched.comment;
  const issueNumberFromUrl = String(comment.issue_url ?? '').match(/\/issues\/(\d+)$/)?.[1];
  if (issueNumberFromUrl !== String(manifest.approvalIssue)) {
    return { ok: false, source: 'live', reason: 'pinned-approval-issue-url-mismatch' };
  }
  const bodyCheck = validateApprovalBody(String(comment.body ?? ''), manifest);
  if (!bodyCheck.ok) {
    return { ok: false, source: 'live', reason: 'pinned-approval-body-invalid' };
  }
  const login = comment.user?.login;
  if (isAutomationLogin(login)) {
    return { ok: false, source: 'live', reason: 'pinned-approval-automation-rejected' };
  }
  const prNumber = options.prNumber ?? parsePullRequestNumberFromEnv();
  const prAuthor = options.prAuthor ?? (prNumber ? await fetchPullRequestAuthor(owner, name, prNumber, token) : null);
  const authorCheck = await validateApprovalAuthor({
    owner,
    name,
    login,
    token,
    prAuthor,
    sourceKind: 'issue-comment',
  });
  if (!authorCheck.ok) {
    return { ok: false, source: 'live', reason: authorCheck.reason };
  }
  return {
    ok: true,
    source: 'pinned-issue-comment',
    reference: `pinned-issue-comment:${comment.id}`,
    marker: manifest.approvalMarker,
    enumerated: manifest.preMoveEnumeratedFiles.join(', '),
    url: comment.html_url,
    author: login,
    permission: authorCheck.permission,
  };
}

export async function resolveImmutableApproval(repoRoot = resolveRepoRoot(), options = {}) {
  const manifest = loadSplitManifest(repoRoot);
  const fixture = process.env.OPK_WALLCLOCK_SPLIT_APPROVAL_FIXTURE ?? options.fixture ?? null;
  if (fixture === 'approved') {
    return {
      ok: true,
      source: 'fixture',
      reference: 'fixture:approved',
      marker: manifest.approvalMarker,
    };
  }
  if (fixture === 'missing') {
    return { ok: false, source: 'fixture', reason: 'missing-approval' };
  }
  if (fixture === 'self-created') {
    return { ok: false, source: 'fixture', reason: 'same-pr-self-created-approval-rejected' };
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    return { ok: false, source: 'live', reason: 'github-context-unavailable' };
  }

  const [owner, name] = repo.split('/');
  const issueNumber = manifest.approvalIssue;
  const marker = manifest.approvalMarker;
  const enumerated = manifest.preMoveEnumeratedFiles.join(', ');
  const ignorePinned =
    process.env.OPK_WALLCLOCK_SPLIT_APPROVAL_IGNORE_PINNED_REF === '1'
    || options.ignorePinnedRef === true;
  const prNumber = parsePullRequestNumberFromEnv();
  const prAuthor = await fetchPullRequestAuthor(owner, name, prNumber, token);
  if (!ignorePinned) {
    const pinned = await resolvePinnedImmutableApproval(manifest, owner, name, token, { prNumber, prAuthor });
    if (pinned.ok) {
      return pinned;
    }
    if (pinned.reason !== 'pinned-approval-ref-missing') {
      return pinned;
    }
  }
  const commentsUrl = `https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}/comments?per_page=100`;
  const commentsRes = await fetch(commentsUrl, { headers: buildGithubHeaders(token) });
  if (!commentsRes.ok) {
    return { ok: false, source: 'live', reason: `comments-fetch-failed:${commentsRes.status}` };
  }
  const comments = await commentsRes.json();
  let rejectedSelfCreated = false;

  for (const comment of comments) {
    const body = String(comment.body ?? '');
    const bodyCheck = validateApprovalBody(body, manifest);
    if (!bodyCheck.ok) {
      continue;
    }
    const authorCheck = await validateApprovalAuthor({
      owner,
      name,
      login: comment.user?.login,
      token,
      prAuthor,
      sourceKind: 'issue-comment',
    });
    if (!authorCheck.ok) {
      if (authorCheck.reason === 'same-pr-self-created-approval-rejected') {
        rejectedSelfCreated = true;
      }
      continue;
    }
    return {
      ok: true,
      source: 'issue-comment',
      reference: `issue-comment:${comment.id}`,
      marker,
      enumerated,
      url: comment.html_url,
      author: comment.user?.login,
      permission: authorCheck.permission,
    };
  }

  if (prNumber) {
    const reviewsUrl = `https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}/reviews?per_page=100`;
    const reviewsRes = await fetch(reviewsUrl, { headers: buildGithubHeaders(token) });
    if (reviewsRes.ok) {
      const reviews = await reviewsRes.json();
      for (const review of reviews) {
        const body = String(review.body ?? '');
        const bodyCheck = validateApprovalBody(body, manifest);
        if (!bodyCheck.ok) {
          continue;
        }
        if (!isApprovedReviewState(review.state)) {
          continue;
        }
        const authorCheck = await validateApprovalAuthor({
          owner,
          name,
          login: review.user?.login,
          token,
          prAuthor,
          sourceKind: 'pr-review',
            });
        if (!authorCheck.ok) {
          if (authorCheck.reason === 'same-pr-self-created-approval-rejected') {
            rejectedSelfCreated = true;
          }
          continue;
        }
        return {
          ok: true,
          source: 'pr-review',
          reference: `pr-review:${review.id}`,
          marker,
          enumerated,
          url: review.html_url,
          author: review.user?.login,
          permission: authorCheck.permission,
        };
      }
    }
  }

  if (rejectedSelfCreated) {
    return { ok: false, source: 'live', reason: 'same-pr-self-created-approval-rejected' };
  }
  return { ok: false, source: 'live', reason: 'missing-immutable-approval-reference' };
}

export function validateRollbackDocumentation(repoRoot = resolveRepoRoot()) {
  const docPath = join(resolveRepoRoot(repoRoot), 'docs/ci-pipeline-split.md');
  const text = readFileSync(docPath, 'utf8');
  const errors = [];
  if (!/wall-clock.*rollback|rollback.*wall-clock/i.test(text)) {
    errors.push('docs/ci-pipeline-split.md missing wall-clock rollback section');
  }
  const hasOrderedSteps =
    /reclassify.*postMergeWallclock/i.test(text)
    && /disable or remove.*vitest-wallclock-e2e/i.test(text);
  if (!hasOrderedSteps) {
    errors.push('docs/ci-pipeline-split.md missing ordered rollback steps (PR re-inclusion before post-merge disable)');
  }
  if (!/disabling post-merge alone.*invalid/i.test(text)) {
    errors.push('docs/ci-pipeline-split.md must document disable-alone rollback as invalid');
  }
  return { ok: errors.length === 0, errors };
}

export function validateRollbackOrderViolationFixture() {
  const disableFirst = {
    prLanesIncludeMoved: false,
    postMergeDisabled: true,
  };
  if (disableFirst.postMergeDisabled && !disableFirst.prLanesIncludeMoved) {
    return {
      ok: true,
      detected: ['rollback-order-violation: post-merge disabled before PR re-inclusion'],
    };
  }
  return { ok: false, detected: [] };
}

function encodeRepoPath(repoPath) {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}

/**
 * Verify latest main head has post-merge wall-clock evidence (Issue #694 AC#3).
 * Fixture: OPK_WALLCLOCK_MAIN_EVIDENCE_FIXTURE=bootstrap|steady-state-ok|missing-steady-state
 */
export async function verifyLatestMainWallClockEvidence(repoRoot = resolveRepoRoot(), options = {}) {
  const manifest = loadSplitManifest(repoRoot);
  const fixture = process.env.OPK_WALLCLOCK_MAIN_EVIDENCE_FIXTURE ?? options.fixture ?? null;
  if (fixture === 'bootstrap') {
    return { ok: true, mode: 'bootstrap', reason: 'fixture:bootstrap' };
  }
  if (fixture === 'steady-state-ok') {
    return { ok: true, mode: 'steady-state', reason: 'fixture:steady-state-ok' };
  }
  if (fixture === 'missing-steady-state') {
    return { ok: false, mode: 'steady-state', reason: 'latest-main-head-lacks-wall-clock-evidence' };
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    if (process.env.GITHUB_ACTIONS !== 'true') {
      return { ok: true, mode: 'bootstrap', reason: 'local-non-ci-default' };
    }
    return { ok: false, reason: 'github-context-unavailable' };
  }

  const [owner, name] = repo.split('/');
  const workflowFile = manifest.mainHeadEvidence?.workflowFile ?? '.github/workflows/vitest-wallclock-e2e.yml';
  const workflowName = manifest.mainHeadEvidence?.workflowName ?? 'vitest-wallclock-e2e';
  const boundedHeadAgeHours = manifest.mainHeadEvidence?.boundedHeadAgeHours ?? 48;

  const workflowOnMain = await githubGetJson(
    `https://api.github.com/repos/${owner}/${name}/contents/${encodeRepoPath(workflowFile)}?ref=main`,
    token,
  );
  if (workflowOnMain.status === 404) {
    return { ok: true, mode: 'bootstrap', reason: 'workflow-not-on-main' };
  }
  if (!workflowOnMain.ok) {
    return { ok: false, reason: `workflow-on-main-fetch-failed:${workflowOnMain.status}` };
  }

  const mainCommit = await githubGetJson(
    `https://api.github.com/repos/${owner}/${name}/commits/main`,
    token,
  );
  if (!mainCommit.ok) {
    return { ok: false, reason: `main-head-fetch-failed:${mainCommit.status}` };
  }
  const mainHeadSha = mainCommit.data.sha;

  const headRuns = await githubGetJson(
    `https://api.github.com/repos/${owner}/${name}/actions/runs?head_sha=${mainHeadSha}&branch=main&per_page=20`,
    token,
  );
  if (!headRuns.ok) {
    return { ok: false, reason: `actions-runs-fetch-failed:${headRuns.status}` };
  }

  const matchingRuns = (headRuns.data.workflow_runs ?? []).filter(
    (run) => run.name === workflowName || String(run.path ?? '').includes('vitest-wallclock-e2e'),
  );
  const successRun = matchingRuns.find(
    (run) => run.status === 'completed'
      && run.conclusion === 'success'
      && run.head_sha === mainHeadSha,
  );
  if (successRun) {
    return {
      ok: true,
      mode: 'steady-state',
      mainHeadSha,
      runId: successRun.id,
      url: successRun.html_url,
    };
  }

  const workflowRuns = await githubGetJson(
    `https://api.github.com/repos/${owner}/${name}/actions/workflows/${encodeRepoPath(workflowFile)}/runs?branch=main&per_page=1`,
    token,
  );
  if (workflowRuns.ok && (workflowRuns.data.total_count ?? 0) === 0) {
    return {
      ok: true,
      mode: 'bootstrap',
      reason: 'first-merge-awaiting-initial-run',
      mainHeadSha,
    };
  }

  const commitDate = new Date(mainCommit.data.commit?.committer?.date ?? mainCommit.data.commit?.author?.date ?? 0);
  const ageHours = Number.isFinite(commitDate.getTime())
    ? (Date.now() - commitDate.getTime()) / (3600 * 1000)
    : boundedHeadAgeHours + 1;
  if (ageHours < boundedHeadAgeHours) {
    return {
      ok: true,
      mode: 'bootstrap',
      reason: 'main-head-within-bounded-age',
      mainHeadSha,
      ageHours,
    };
  }

  return {
    ok: false,
    mode: 'steady-state',
    reason: 'latest-main-head-lacks-wall-clock-evidence',
    mainHeadSha,
    ageHours,
  };
}
