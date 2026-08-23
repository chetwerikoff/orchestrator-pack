import {
  applyListedJq,
  ghApiJson,
  mapIssueToGhJson,
  mapPullState,
  mapPullToGhJson,
  pickJsonFields,
  resolveNameWithOwner,
  resolveRepoContext,
  REST_ERROR_MARKER,
} from './gh-repo-resolve.mjs';
import { aggregateChecks, extractActionsRunId, mergeCheckContexts } from './gh-pr-checks.mjs';

const RUNTIME_HISTORY_REPO = 'chetwerikoff/orchestrator-pack';

/**
 * @param {Record<string, unknown>} pull
 */
function mapPullMergeable(pull) {
  if (pull.mergeable === true) {
    return 'MERGEABLE';
  }
  if (pull.mergeable === false) {
    return 'CONFLICTING';
  }
  return 'UNKNOWN';
}

/**
 * @param {Record<string, unknown>} pull
 */
function mapPullMergeStateStatus(pull) {
  const state = String(pull.mergeable_state ?? '').toUpperCase();
  const supported = new Set(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE', 'UNKNOWN']);
  return supported.has(state) ? state : 'UNKNOWN';
}

/**
 * Projection for the waiver runbook's additional pull fields. Keep the
 * underlying gh-repo mapper unchanged for callers outside this route.
 *
 * @param {Record<string, unknown>} pull
 * @param {string[]} fields
 */
export function mapPullForFields(pull, fields) {
  const mapped = mapPullToGhJson(pull, fields);
  return pickJsonFields({
    ...mapped,
    mergeable: mapPullMergeable(pull),
    mergeStateStatus: mapPullMergeStateStatus(pull),
    mergeCommit: pull.merge_commit_sha ? { oid: pull.merge_commit_sha } : null,
  }, fields);
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {number} issueNumber
 * @param {number} limit
 * @param {string[]} fields
 * @param {string} cwd
 */
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
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      continue;
    }
    const pull = fetchPull(realGh, repo, prNumber, cwd);
    results.push(mapPullToGhJson(pull, fields));
    if (results.length >= limit) {
      break;
    }
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
 * @param {string} ref
 * @returns {{ prNumber: number, slug?: string, host?: string | null } | null}
 */
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
      const slug = `${owner}/${repoName}`;
      return {
        prNumber,
        slug,
        host,
      };
    }
  }
  return null;
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {string} ref
 * @param {string} cwd
 */
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
    if (!Array.isArray(pulls) || pulls.length === 0) {
      break;
    }
    for (const pull of pulls) {
      if (pull.head?.ref === ref) {
        return pull;
      }
    }
    if (pulls.length < perPage) {
      break;
    }
    page += 1;
  }

  throw new Error(`${REST_ERROR_MARKER}: no pull found for ref ${ref}`);
}

/**
 * @param {string} realGh
 * @param {{ slug: string, host: string }} repo
 * @param {string} prRef
 * @param {string[]} fields
 * @param {string | null} jq
 * @param {string} cwd
 */
export function routePrView(realGh, repo, prRef, fields, jq, cwd) {
  const pull = fetchPullByReference(realGh, repo, prRef, cwd);
  const mapped = mapPullForFields(pull, fields);
  if (jq === '.headRefOid') {
    return mapped.headRefOid;
  }
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
 * @param {boolean} [includeAppId]
 */
export function routePrChecks(realGh, repo, prNumber, cwd, includeAppId = false) {
  const pull = fetchPull(realGh, repo, prNumber, cwd);
  const headSha = pull.head?.sha;
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
  return aggregateChecks(contexts, { includeAppId });
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
function fetchIssue(realGh, repo, issueNumber, cwd) {
  return ghApiJson(realGh, `repos/${repo.slug}/issues/${issueNumber}`, {
    hostname: repo.host,
    cwd,
  });
}

export function routeIssueView(realGh, repo, issueNumber, fields, jq, cwd) {
  const issue = fetchIssue(realGh, repo, issueNumber, cwd);
  const mapped = mapIssueToGhJson(issue, fields);
  return applyListedJq(mapped, jq);
}

export function routeIssueViewBody(realGh, repo, issueNumber, cwd) {
  return routeIssueView(realGh, repo, issueNumber, ['body'], null, cwd);
}

function assertRuntimeHistoryRepo(route, repo) {
  if (route.repoSlug !== RUNTIME_HISTORY_REPO || repo.slug !== RUNTIME_HISTORY_REPO) {
    throw new Error(`${REST_ERROR_MARKER}: runtime-history route repository mismatch`);
  }
}

export function routeRuntimeHistoryMainRequiredStatusChecks(realGh, repo, cwd) {
  return ghApiJson(
    realGh,
    `repos/${repo.slug}/branches/main/protection/required_status_checks`,
    { hostname: repo.host, cwd },
  );
}

export function routeRuntimeHistoryActionsRun(realGh, repo, runId, cwd) {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`${REST_ERROR_MARKER}: invalid runtime-history actions run id`);
  }
  return ghApiJson(realGh, `repos/${repo.slug}/actions/runs/${runId}`, {
    hostname: repo.host,
    cwd,
  });
}

export function routeRuntimeHistoryStatusHistory(realGh, repo, headSha, cwd) {
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error(`${REST_ERROR_MARKER}: invalid runtime-history status-history head sha`);
  }

  const rows = [];
  const seenIds = new Set();
  const perPage = 100;
  let page = 1;
  while (true) {
    if (page > 20) {
      throw new Error(`${REST_ERROR_MARKER}: runtime-history status pagination completeness unprovable`);
    }
    const batch = ghApiJson(
      realGh,
      `repos/${repo.slug}/commits/${headSha}/statuses?per_page=${perPage}&page=${page}`,
      { hostname: repo.host, cwd },
    );
    if (!Array.isArray(batch)) {
      throw new Error(`${REST_ERROR_MARKER}: runtime-history status history payload is not an array`);
    }
    for (const row of batch) {
      const id = Number(row?.id);
      if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) {
        throw new Error(`${REST_ERROR_MARKER}: runtime-history status history identity is malformed`);
      }
      if (row.sha && String(row.sha).toLowerCase() !== headSha.toLowerCase()) {
        throw new Error(`${REST_ERROR_MARKER}: runtime-history status history escaped exact head`);
      }
      seenIds.add(id);
      rows.push(row);
    }
    if (batch.length < perPage) {
      break;
    }
    page += 1;
  }

  return rows;
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
      case 'pr-list-merged-closes': {
        const limit = Number(parsed.flags['--limit']);
        const fields = parsed.jsonFields ?? ['number', 'title', 'state', 'mergedAt'];
        return routePrListMergedCloses(realGh, repo, route.prNumber, limit, fields, cwd);
      }
      case 'pr-view':
        return routePrView(
          realGh,
          repo,
          route.prRef ?? String(route.prNumber),
          parsed.jsonFields ?? [],
          parsed.jq,
          cwd,
        );
      case 'pr-checks':
        return routePrChecks(realGh, repo, route.prNumber, cwd, route.includeAppId === true);
      case 'pr-diff-name-only': {
        return routePrDiffNameOnly(realGh, repo, route.prNumber, cwd);
      }
      case 'issue-view-body':
      case 'issue-view-json': {
        return routeIssueView(
          realGh,
          repo,
          route.prNumber,
          parsed.jsonFields ?? ['body'],
          parsed.jq,
          cwd,
        );
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
      case 'runtime-history-main-required-status-checks':
        assertRuntimeHistoryRepo(route, repo);
        return routeRuntimeHistoryMainRequiredStatusChecks(realGh, repo, cwd);
      case 'runtime-history-actions-run':
        assertRuntimeHistoryRepo(route, repo);
        return routeRuntimeHistoryActionsRun(realGh, repo, route.runId, cwd);
      case 'runtime-history-status-history':
        assertRuntimeHistoryRepo(route, repo);
        return routeRuntimeHistoryStatusHistory(realGh, repo, route.headSha, cwd);
      default:
        throw new Error(`${REST_ERROR_MARKER}: unknown route ${routeId}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(REST_ERROR_MARKER)) {
      throw err;
    }
    throw new Error(`${REST_ERROR_MARKER}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export { mapPullState };
