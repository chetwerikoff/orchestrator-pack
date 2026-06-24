/**
 * gh pr checks REST parity — dedupe rules pinned to gh CLI v2.93.0 aggregate.go.
 */

/**
 * @typedef {object} CheckContext
 * @property {string} [context]
 * @property {string} [name]
 * @property {string} [state]
 * @property {string} [status]
 * @property {string} [conclusion]
 * @property {string} [targetUrl]
 * @property {string} [detailsUrl]
 * @property {string} [description]
 * @property {string} [startedAt]
 * @property {string} [completedAt]
 * @property {{ workflowRun?: { workflow?: { name?: string }, event?: string } }} [checkSuite]
 */

/**
 * @param {CheckContext[]} checkContexts
 */
export function eliminateDuplicates(checkContexts) {
  const sorted = [...checkContexts].sort((a, b) => {
    const aTime = Date.parse(a.startedAt ?? '') || 0;
    const bTime = Date.parse(b.startedAt ?? '') || 0;
    return bTime - aTime;
  });

  const mapChecks = new Map();
  const mapContexts = new Map();
  const unique = [];

  for (const ctx of sorted) {
    if (ctx.context) {
      if (mapContexts.has(ctx.context)) {
        continue;
      }
      mapContexts.set(ctx.context, true);
    } else {
      const workflow = ctx.checkSuite?.workflowRun?.workflow?.name ?? '';
      const event = ctx.checkSuite?.workflowRun?.event ?? '';
      const key = `${ctx.name ?? ''}/${workflow}/${event}`;
      if (mapChecks.has(key)) {
        continue;
      }
      mapChecks.set(key, true);
    }
    unique.push(ctx);
  }

  return unique;
}

/**
 * @param {string} state
 */
export function bucketForState(state) {
  switch (state) {
    case 'SUCCESS':
      return 'pass';
    case 'SKIPPED':
    case 'NEUTRAL':
      return 'skipping';
    case 'ERROR':
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
      return 'fail';
    case 'CANCELLED':
      return 'cancel';
    default:
      return 'pending';
  }
}

/**
 * @param {CheckContext} c
 */
function resolveState(c) {
  let state = c.state ?? '';
  if (!state) {
    if (c.status === 'COMPLETED' || c.status === 'completed') {
      state = (c.conclusion ?? '').toUpperCase();
    } else {
      state = (c.status ?? '').toUpperCase();
    }
  }
  return state;
}

/**
 * Native `gh pr checks` exit parity (v2.93.0): 0 all pass, 1 any fail, 8 pending (no fail).
 *
 * @param {Array<{ bucket?: string }>} checks
 */
export function exitCodeForPrChecks(checks) {
  let hasPending = false;
  for (const check of checks) {
    const bucket = check.bucket ?? '';
    if (bucket === 'fail') {
      return 1;
    }
    if (bucket === 'pending') {
      hasPending = true;
    }
  }
  return hasPending ? 8 : 0;
}

/**
 * @param {CheckContext[]} checkContexts
 */
export function aggregateChecks(checkContexts) {
  const checks = [];
  for (const c of eliminateDuplicates(checkContexts)) {
    const state = resolveState(c);
    const link = c.detailsUrl || c.targetUrl || '';
    const name = c.name || c.context || '';
    const item = {
      name,
      state,
      startedAt: c.startedAt ?? null,
      completedAt: c.completedAt ?? null,
      link,
      bucket: bucketForState(state),
      workflow: c.checkSuite?.workflowRun?.workflow?.name ?? '',
      description: c.description ?? '',
    };
    checks.push(item);
  }
  return checks;
}

/**
 * @param {Record<string, unknown>} statusRun
 */
export function statusRunToContext(statusRun) {
  return {
    context: statusRun.context,
    state: String(statusRun.state ?? '').toUpperCase(),
    targetUrl: statusRun.target_url,
    description: statusRun.description ?? '',
    startedAt: statusRun.created_at,
    completedAt: statusRun.updated_at,
  };
}

/**
 * @param {string} url
 */
export function extractActionsRunId(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const match = /\/actions\/runs\/(\d+)/.exec(url);
  return match ? match[1] : null;
}

/**
 * @param {Record<string, unknown>} run
 */
export function checkRunToContext(run) {
  const detailsUrl = run.details_url ?? run.html_url ?? '';
  const runId = extractActionsRunId(String(detailsUrl));
  return {
    name: run.name,
    status: String(run.status ?? '').toUpperCase(),
    conclusion: run.conclusion ? String(run.conclusion).toUpperCase() : '',
    startedAt: run.started_at,
    completedAt: run.completed_at,
    detailsUrl,
    description: run.output?.summary ?? run.output?.title ?? '',
    checkSuite: {
      workflowRun: {
        workflow: { name: run.__workflowName ?? '' },
        event: run.__workflowEvent ?? '',
      },
      __actionsRunId: runId,
    },
  };
}

/**
 * @param {Array<Record<string, unknown>>} checkRuns
 * @param {Record<string, unknown>} combinedStatus
 */
export function mergeCheckContexts(checkRuns, combinedStatus) {
  const contexts = [];
  for (const run of checkRuns) {
    contexts.push(checkRunToContext(run));
  }
  const statuses = combinedStatus?.statuses ?? [];
  for (const s of statuses) {
    contexts.push(statusRunToContext(s));
  }
  return contexts;
}
