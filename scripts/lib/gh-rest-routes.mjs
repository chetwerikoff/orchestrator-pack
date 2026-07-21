import {
  applyListedJq,
  ghApiJson,
  mapIssueToGhJson,
  mapPullState,
  mapPullToGhJson,
  resolveNameWithOwner,
  resolveRepoContext,
  REST_ERROR_MARKER,
} from './gh-repo-resolve.mjs';
import { aggregateChecks, extractActionsRunId, mergeCheckContexts } from './gh-pr-checks.mjs';

export function routePrListMergedCloses(realGh, repo, issueNumber, limit, fields, cwd) {
  const q = `repo:${repo.slug} is:pr is:merged closes:${issueNumber}`;
  const perPage = Math.min(limit, 100);
  const search = ghApiJson(
    realGh,
    `search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}`,
    { hostname: repo.host, cwd },
  );
  const items = Array.isArray(search.items) ? search.items : [];
  const results = [];
  for (const item of items) {
    const prNumber = Number(item.number);
    if (!Number.isFinite(prNumber) || prNumber <= 0) continue;
    const pull = fetchPull(realGh, repo, prNumber, cwd);
    results.push(mapPullToGhJson(pull, fields));
    if (results.length >= limit) break;
  }
  return results;
}

export function fetchOpenPrList(realGh, repo, state, limit, fields, cwd) {
  const perPage = 100;
  const max = Math.min(limit, 200);
  let page = 1;
  const all = [];
  while (all.length < max) {
    const batch = ghApiJson(
      realGh,
      `repos/${repo.slug}/pulls?state=${state}&per_page=${perPage}&page=${page}`,
      { hostname: repo.host, cwd },
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const pull of batch) {
      all.push(mapPullToGhJson(pull, fields));
      if (all.length >= max) break;
    }
    if (batch.length < perPage) break;
    page += 1;
  }
  return all;
}

function fetchPull(realGh, repo, prNumber, cwd) {
  return ghApiJson(realGh, `repos/${repo.slug}/pulls/${prNumber}`, {
    hostname: repo.host,
    cwd,
  });
}

export function parsePullReference(ref) {
  const trimmed = String(ref).trim();
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return { prNumber: asNum };
  }
  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  );
  if (urlMatch) {
    const [, host, owner, repoName, numStr] = urlMatch;
    const prNumber = Number(numStr);
    if (Number.isFinite(prNumber) && prNumber > 0) {
      return { prNumber, slug: `${owner}/${repoName}`, host };
    }
  }
  return null;
}

function fetchPullByReference(realGh, repo, ref, cwd) {
  const parsed = parsePullReference(ref);
  if (parsed?.prNumber) {
    const targetRepo = parsed.slug
      ? { slug: parsed.slug, host: parsed.host ?? null }
      : repo;
    return fetchPull(realGh, targetRepo, parsed.prNumber, cwd);
  }
  const perPage = 100;
  let page = 1;
  while (true) {
    const pulls = ghApiJson(
      realGh,
      `repos/${repo.slug}/pulls?state=open&per_page=${perPage}&page=${page}`,
      { hostname: repo.host, cwd },
    );
    if (!Array.isArray(pulls) || pulls.length === 0) break;
    for (const pull of pulls) {
      if (pull.head?.ref === ref) return pull;
    }
    if (pulls.length < perPage) break;
    page += 1;
  }
  throw new Error(`${REST_ERROR_MARKER}: no pull found for ref ${ref}`);
}

export function routePrView(realGh, repo, prRef, fields, jq, cwd) {
  const pull = fetchPullByReference(realGh, repo, prRef, cwd);
  return applyListedJq(mapPullToGhJson(pull, fields), jq);
}

export function routePrListHead(realGh, repo, branch, fields, jq, limit, cwd) {
  const perPage = 100;
  const filtered = [];
  let page = 1;
  const maxCollect = limit ?? 200;
  outer: while (filtered.length < maxCollect) {
    const pulls = ghApiJson(
      realGh,
      `repos/${repo.slug}/pulls?state=open&per_page=${perPage}&page=${page}`,
      { hostname: repo.host, cwd },
    );
    if (!Array.isArray(pulls) || pulls.length === 0) break;
    for (const pull of pulls) {
      if (pull.head?.ref === branch) {
        filtered.push(mapPullToGhJson(pull, fields));
        if (filtered.length >= maxCollect) break outer;
      }
    }
    if (pulls.length < perPage) break;
    page += 1;
  }
  if (!limit && filtered.length > 1) {
    throw new Error(`${REST_ERROR_MARKER}: ambiguous head ref ${branch}`);
  }
  return applyListedJq(filtered, jq);
}

function enrichCheckRunsWithWorkflow(realGh, repo, checkRuns, cwd) {
  const runCache = new Map();
  for (const run of checkRuns) {
    const url = String(run.details_url ?? run.html_url ?? '');
    const actionsRunId = extractActionsRunId(url);
    if (!actionsRunId) continue;
    if (!runCache.has(actionsRunId)) {
      try {
        const actionsRun = ghApiJson(
          realGh,
          `repos/${repo.slug}/actions/runs/${actionsRunId}`,
          { hostname: repo.host, cwd },
        );
        runCache.set(actionsRunId, {
          name: actionsRun.name ?? '',
          event: actionsRun.event ?? '',
        });
      } catch {
        runCache.set(actionsRunId, { name: '', event: '' });
      }
    }
    const cached = runCache.get(actionsRunId);
    run.__workflowName = cached?.name ?? '';
    run.__workflowEvent = cached?.event ?? '';
  }
  return checkRuns;
}

export function routePrChecks(realGh, repo, prNumber, cwd) {
  const pull = fetchPull(realGh, repo, prNumber, cwd);
  const headSha = pull.head?.sha;
  if (!headSha) throw new Error(`${REST_ERROR_MARKER}: missing head sha for PR ${prNumber}`);
  const checkRuns = [];
  let page = 1;
  const perPage = 100;
  let totalCount = null;
  while (true) {
    const response = ghApiJson(
      realGh,
      `repos/${repo.slug}/commits/${headSha}/check-runs?per_page=${perPage}&page=${page}`,
      { hostname: repo.host, cwd },
    );
    if (totalCount === null && typeof response.total_count === 'number') totalCount = response.total_count;
    const runs = response.check_runs ?? [];
    checkRuns.push(...runs);
    if (runs.length < perPage) break;
    if (totalCount !== null && checkRuns.length >= totalCount) break;
    if (page > 20) throw new Error(`${REST_ERROR_MARKER}: check-runs pagination completeness unprovable`);
    page += 1;
  }
  if (totalCount !== null && totalCount > 1000) {
    throw new Error(`${REST_ERROR_MARKER}: check-runs count exceeds documented suite limit`);
  }
  enrichCheckRunsWithWorkflow(realGh, repo, checkRuns, cwd);
  const combined = ghApiJson(realGh, `repos/${repo.slug}/commits/${headSha}/status`, {
    hostname: repo.host,
    cwd,
  });
  return aggregateChecks(mergeCheckContexts(checkRuns, combined));
}

export function routePrDiffNameOnly(realGh, repo, prNumber, cwd) {
  const pull = fetchPull(realGh, repo, prNumber, cwd);
  const changedFiles = pull.changed_files;
  if (typeof changedFiles !== 'number') {
    throw new Error(`${REST_ERROR_MARKER}: changed_files missing on pull ${prNumber}`);
  }
  if (changedFiles > 3000) {
    throw new Error(`${REST_ERROR_MARKER}: changed_files > 3000; completeness unprovable`);
  }
  const filenames = [];
  let page = 1;
  const perPage = 100;
  while (filenames.length < changedFiles) {
    const batch = ghApiJson(
      realGh,
      `repos/${repo.slug}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`,
      { hostname: repo.host, cwd },
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const file of batch) {
      if (file.filename) filenames.push(file.filename);
      else if (file.previous_filename) filenames.push(file.previous_filename);
    }
    if (batch.length < perPage) break;
    page += 1;
  }
  if (filenames.length !== changedFiles) {
    throw new Error(`${REST_ERROR_MARKER}: pr diff file count mismatch (${filenames.length} != ${changedFiles})`);
  }
  return filenames;
}

function fetchIssue(realGh, repo, issueNumber, cwd) {
  return ghApiJson(realGh, `repos/${repo.slug}/issues/${issueNumber}`, {
    hostname: repo.host,
    cwd,
  });
}

export function routeIssueView(realGh, repo, issueNumber, fields, jq, cwd) {
  return applyListedJq(mapIssueToGhJson(fetchIssue(realGh, repo, issueNumber, cwd), fields), jq);
}

export function routeIssueViewBody(realGh, repo, issueNumber, cwd) {
  return routeIssueView(realGh, repo, issueNumber, ['body'], null, cwd);
}

export function routePullReview(realGh, repo, prNumber, reviewId, cwd) {
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !/^\d+$/.test(String(reviewId ?? ''))) {
    throw new Error(`${REST_ERROR_MARKER}: invalid exact pull review identity`);
  }
  const review = ghApiJson(
    realGh,
    `repos/${repo.slug}/pulls/${prNumber}/reviews/${reviewId}`,
    { hostname: repo.host, cwd },
  );
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new Error(`${REST_ERROR_MARKER}: pull review response must be an object`);
  }
  return {
    id: String(review.id ?? ''),
    commitId: String(review.commit_id ?? ''),
    state: String(review.state ?? ''),
    body: String(review.body ?? ''),
    submittedAt: review.submitted_at ? String(review.submitted_at) : null,
    authorLogin: String(review.user?.login ?? ''),
  };
}

export function executeRestRoute(routeId, ctx) {
  const { realGh, parsed, route, cwd = process.cwd() } = ctx;
  try {
    if (routeId === 'api-pull-review') {
      const repoSlug = String(route.repoSlug ?? '');
      if (!/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) {
        throw new Error(`${REST_ERROR_MARKER}: exact pull review route requires repository slug`);
      }
      return routePullReview(
        realGh,
        { slug: repoSlug, host: parsed.hostname },
        Number(route.prNumber),
        String(route.reviewId ?? ''),
        cwd,
      );
    }

    const repo = resolveRepoContext({
      cwd,
      repoFlag: parsed.repo,
      realGh,
      hostname: parsed.hostname,
    });

    switch (routeId) {
      case 'pr-list-open': {
        const limit = Number(parsed.flags['--limit'] ?? 200);
        return applyListedJq(fetchOpenPrList(realGh, repo, 'open', limit, parsed.jsonFields ?? [], cwd), parsed.jq);
      }
      case 'pr-list-head': {
        const fields = parsed.jsonFields ?? ['number'];
        const limitFlag = parsed.flags['--limit'];
        return routePrListHead(realGh, repo, route.branch, fields, parsed.jq, limitFlag ? Number(limitFlag) : null, cwd);
      }
      case 'pr-list-merged-closes':
        return routePrListMergedCloses(
          realGh,
          repo,
          route.prNumber,
          Number(parsed.flags['--limit']),
          parsed.jsonFields ?? ['number', 'title', 'state', 'mergedAt'],
          cwd,
        );
      case 'pr-view':
        return routePrView(realGh, repo, route.prRef ?? String(route.prNumber), parsed.jsonFields ?? [], parsed.jq, cwd);
      case 'pr-checks':
        return routePrChecks(realGh, repo, route.prNumber, cwd);
      case 'pr-diff-name-only':
        return routePrDiffNameOnly(realGh, repo, route.prNumber, cwd);
      case 'issue-view-body':
      case 'issue-view-json':
        return routeIssueView(realGh, repo, route.prNumber, parsed.jsonFields ?? ['body'], parsed.jq, cwd);
      case 'repo-view-name-with-owner':
        return applyListedJq({
          nameWithOwner: resolveNameWithOwner({
            cwd,
            repoFlag: parsed.repo,
            realGh,
            hostname: parsed.hostname,
          }),
        }, parsed.jq);
      default:
        throw new Error(`${REST_ERROR_MARKER}: unknown route ${routeId}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(REST_ERROR_MARKER)) throw err;
    throw new Error(`${REST_ERROR_MARKER}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export { mapPullState };
