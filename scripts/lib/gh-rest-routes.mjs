import {
  applyListedJq,
  ghApiJson,
  mapPullState,
  mapPullToGhJson,
  pickJsonFields,
  resolveNameWithOwner,
  resolveRepoContext,
  REST_ERROR_MARKER,
} from './gh-repo-resolve.mjs';
import { aggregateChecks, extractActionsRunId, mergeCheckContexts } from './gh-pr-checks.mjs';

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {string} state
 * @param {number} limit
 * @param {string[]} fields
 * @param {string} cwd
 */
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
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    for (const pull of batch) {
      all.push(mapPullToGhJson(pull, fields));
      if (all.length >= max) {
        break;
      }
    }
    if (batch.length < perPage) {
      break;
    }
    page += 1;
  }

  return all;
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {number} prNumber
 * @param {string} cwd
 */
function fetchPull(realGh, repo, prNumber, cwd) {
  return ghApiJson(realGh, `repos/${repo.slug}/pulls/${prNumber}`, {
    hostname: repo.host,
    cwd,
  });
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {number} prNumber
 * @param {string[]} fields
 * @param {string | null} jq
 * @param {string} cwd
 */
export function routePrView(realGh, repo, prNumber, fields, jq, cwd) {
  const pull = fetchPull(realGh, repo, prNumber, cwd);
  const mapped = mapPullToGhJson(pull, fields);
  return applyListedJq(mapped, jq);
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {string} branch
 * @param {string[]} fields
 * @param {string | null} jq
 * @param {number | null} limit
 * @param {string} cwd
 */
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
    if (!Array.isArray(pulls) || pulls.length === 0) {
      break;
    }
    for (const pull of pulls) {
      if (pull.head?.ref === branch) {
        filtered.push(mapPullToGhJson(pull, fields));
        if (filtered.length >= maxCollect) {
          break outer;
        }
      }
    }
    if (pulls.length < perPage) {
      break;
    }
    page += 1;
  }

  if (!limit && filtered.length > 1) {
    throw new Error(`${REST_ERROR_MARKER}: ambiguous head ref ${branch}`);
  }
  return applyListedJq(filtered, jq);
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {Array<Record<string, unknown>>} checkRuns
 * @param {string} cwd
 */
function enrichCheckRunsWithWorkflow(realGh, repo, checkRuns, cwd) {
  const runCache = new Map();
  for (const run of checkRuns) {
    const url = String(run.details_url ?? run.html_url ?? '');
    const actionsRunId = extractActionsRunId(url);
    if (!actionsRunId) {
      continue;
    }
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

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {number} prNumber
 * @param {string} cwd
 */
export function routePrChecks(realGh, repo, prNumber, cwd) {
  const pull = fetchPull(realGh, repo, prNumber, cwd);
  const headSha = pull.head?.sha;
  const headRef = pull.head?.ref ?? 'unknown';
  if (!headSha) {
    throw new Error(`${REST_ERROR_MARKER}: missing head sha for PR ${prNumber}`);
  }

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
    if (totalCount === null && typeof response.total_count === 'number') {
      totalCount = response.total_count;
    }
    const runs = response.check_runs ?? [];
    checkRuns.push(...runs);
    if (runs.length < perPage) {
      break;
    }
    if (totalCount !== null && checkRuns.length >= totalCount) {
      break;
    }
    if (page > 20) {
      throw new Error(`${REST_ERROR_MARKER}: check-runs pagination completeness unprovable`);
    }
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

  const contexts = mergeCheckContexts(checkRuns, combined);
  if (contexts.length === 0) {
    throw new Error(`no checks reported on the '${headRef}' branch`);
  }

  return aggregateChecks(contexts);
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {number} prNumber
 * @param {string} cwd
 */
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
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    for (const file of batch) {
      if (file.filename) {
        filenames.push(file.filename);
      } else if (file.previous_filename) {
        filenames.push(file.previous_filename);
      }
    }
    if (batch.length < perPage) {
      break;
    }
    page += 1;
  }

  if (filenames.length !== changedFiles) {
    throw new Error(`${REST_ERROR_MARKER}: pr diff file count mismatch (${filenames.length} != ${changedFiles})`);
  }

  return filenames;
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {number} issueNumber
 * @param {string} cwd
 */
export function routeIssueViewBody(realGh, repo, issueNumber, cwd) {
  const issue = ghApiJson(realGh, `repos/${repo.slug}/issues/${issueNumber}`, {
    hostname: repo.host,
    cwd,
  });
  return { body: issue.body ?? '' };
}

/**
 * @param {import('./gh-inventory-match.mjs').InventoryRouteId} routeId
 * @param {object} ctx
 */
export function executeRestRoute(routeId, ctx) {
  const {
    realGh,
    parsed,
    route,
    cwd = process.cwd(),
  } = ctx;

  const repo = resolveRepoContext({
    cwd,
    repoFlag: parsed.repo,
    realGh,
    hostname: parsed.hostname,
  });

  try {
    switch (routeId) {
      case 'pr-list-open': {
        const limit = Number(parsed.flags['--limit'] ?? 200);
        const fields = parsed.jsonFields ?? [];
        const rows = fetchOpenPrList(realGh, repo, 'open', limit, fields, cwd);
        return applyListedJq(rows, parsed.jq);
      }
      case 'pr-list-head': {
        const fields = parsed.jsonFields ?? ['number'];
        const limitFlag = parsed.flags['--limit'];
        const limit = limitFlag ? Number(limitFlag) : null;
        return routePrListHead(realGh, repo, route.branch, fields, parsed.jq, limit, cwd);
      }
      case 'pr-view':
        return routePrView(realGh, repo, route.prNumber, parsed.jsonFields ?? [], parsed.jq, cwd);
      case 'pr-checks':
        return routePrChecks(realGh, repo, route.prNumber, cwd);
      case 'pr-diff-name-only': {
        const files = routePrDiffNameOnly(realGh, repo, route.prNumber, cwd);
        return files;
      }
      case 'issue-view-body': {
        const body = routeIssueViewBody(realGh, repo, route.prNumber, cwd);
        return applyListedJq(body, parsed.jq);
      }
      case 'repo-view-name-with-owner': {
        const repoView = {
          nameWithOwner: resolveNameWithOwner({
            cwd,
            repoFlag: parsed.repo,
            realGh,
            hostname: parsed.hostname,
          }),
        };
        return applyListedJq(repoView, parsed.jq);
      }
      default:
        throw new Error(`${REST_ERROR_MARKER}: unknown route ${routeId}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(REST_ERROR_MARKER)) {
      throw err;
    }
    if (err instanceof Error && err.message.startsWith('no checks reported')) {
      throw err;
    }
    throw new Error(`${REST_ERROR_MARKER}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export { mapPullState };
