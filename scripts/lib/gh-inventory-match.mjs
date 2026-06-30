import { jsonFieldsEqual, parseGhArgv } from './gh-parse-argv.mjs';

/** @typedef {'pr-list-open' | 'pr-list-head' | 'pr-list-merged-closes' | 'pr-view' | 'pr-checks' | 'pr-diff-name-only' | 'issue-view-body' | 'issue-view-json' | 'repo-view-name-with-owner'} InventoryRouteId */

/** scm-github prInfoFromView consumer fields (resolvePR + detectPR; Issue #530). */
export const PR_INFO_FROM_VIEW_FIELDS = Object.freeze([
  'baseRefName',
  'headRefName',
  'isDraft',
  'number',
  'title',
  'url',
]);

/**
 * @param {string | boolean | undefined} searchFlag
 * @returns {number | null}
 */
function parseClosesIssueSearch(searchFlag) {
  if (typeof searchFlag !== 'string') {
    return null;
  }
  const match = searchFlag.trim().match(/^closes\s+#(\d+)$/i);
  if (!match) {
    return null;
  }
  const issueNumber = Number(match[1]);
  return Number.isFinite(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

/**
 * @param {ReturnType<typeof parseGhArgv>} parsed
 * @param {string[]} allowed
 */
export function hasOnlyAllowedFlags(parsed, allowed) {
  const allowedSet = new Set(allowed);
  return Object.keys(parsed.flags).every((key) => allowedSet.has(key));
}

/**
 * @param {ReturnType<typeof parseGhArgv>} parsed
 * @returns {{ id: InventoryRouteId, prNumber?: number, branch?: string } | null}
 */
export function matchInventoryRoute(parsed) {
  const [root, sub] = parsed.subcommand;
  if (!root) {
    return null;
  }

  if (root === 'api') {
    return null;
  }

  if (root === 'repo' && sub === 'view') {
    if (!hasOnlyAllowedFlags(parsed, [])) {
      return null;
    }
    if (!jsonFieldsEqual(parsed.jsonFields, ['nameWithOwner'])) {
      return null;
    }
    if (parsed.jq && parsed.jq !== '.nameWithOwner') {
      return null;
    }
    return { id: 'repo-view-name-with-owner' };
  }

  if (root === 'issue' && sub === 'view') {
    if (!hasOnlyAllowedFlags(parsed, [])) {
      return null;
    }
    const num = Number(parsed.positionals[0]);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    const fields = parsed.jsonFields;
    if (!fields) {
      return null;
    }

    const allowedSets = [
      ['body'],
      ['number', 'title', 'body', 'url', 'state', 'stateReason', 'labels', 'assignees'],
      ['state', 'stateReason'],
      ['state', 'title', 'body'],
      ['state', 'title', 'body', 'closedAt'],
      ['title', 'body', 'state'],
    ];
    const normalizedAllowed = allowedSets.map((set) => [...set].sort());
    const sorted = [...fields].sort();
    const matched = normalizedAllowed.find(
      (set) => set.length === sorted.length && set.every((f, i) => f === sorted[i]),
    );
    if (!matched) {
      return null;
    }

    if (parsed.jq && parsed.jq !== '.body') {
      return null;
    }
    if (parsed.jq === '.body' && !jsonFieldsEqual(fields, ['body'])) {
      return null;
    }

    return {
      id: jsonFieldsEqual(fields, ['body']) ? 'issue-view-body' : 'issue-view-json',
      prNumber: num,
    };
  }

  if (root !== 'pr') {
    return null;
  }

  if (sub === 'diff') {
    if (!hasOnlyAllowedFlags(parsed, ['--name-only'])) {
      return null;
    }
    const num = Number(parsed.positionals[0]);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    if (parsed.flags['--name-only'] !== true && parsed.flags['--name-only'] !== 'true') {
      return null;
    }
    return { id: 'pr-diff-name-only', prNumber: num };
  }

  if (sub === 'checks') {
    if (!hasOnlyAllowedFlags(parsed, [])) {
      return null;
    }
    const num = Number(parsed.positionals[0]);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    const expected = [
      'bucket',
      'completedAt',
      'description',
      'link',
      'name',
      'startedAt',
      'state',
      'workflow',
    ];
    if (!jsonFieldsEqual(parsed.jsonFields, expected)) {
      return null;
    }
    if (parsed.jq) {
      return null;
    }
    return { id: 'pr-checks', prNumber: num };
  }

  if (sub === 'list') {
    const headFlag = parsed.flags['--head'];
    const closesIssueNumber = parseClosesIssueSearch(parsed.flags['--search']);
    if (
      parsed.flags['--state'] === 'merged'
      && closesIssueNumber
      && jsonFieldsEqual(parsed.jsonFields, ['mergedAt', 'number', 'state', 'title'])
    ) {
      if (!hasOnlyAllowedFlags(parsed, ['--state', '--search', '--limit'])) {
        return null;
      }
      const limit = Number(parsed.flags['--limit'] ?? 0);
      if (!Number.isFinite(limit) || limit <= 0 || limit > 30) {
        return null;
      }
      if (parsed.jq) {
        return null;
      }
      return { id: 'pr-list-merged-closes', prNumber: closesIssueNumber };
    }

    if (headFlag && typeof headFlag === 'string') {
      if (jsonFieldsEqual(parsed.jsonFields, ['number', 'url'])) {
        if (!hasOnlyAllowedFlags(parsed, ['--head', '--limit'])) {
          return null;
        }
        if (parsed.flags['--limit'] !== '1') {
          return null;
        }
        if (parsed.jq) {
          return null;
        }
        return { id: 'pr-list-head', branch: headFlag };
      }

      if (jsonFieldsEqual(parsed.jsonFields, [...PR_INFO_FROM_VIEW_FIELDS])) {
        if (!hasOnlyAllowedFlags(parsed, ['--head', '--limit'])) {
          return null;
        }
        if (parsed.flags['--limit'] !== '1') {
          return null;
        }
        if (parsed.jq) {
          return null;
        }
        return { id: 'pr-list-head', branch: headFlag };
      }

      if (!hasOnlyAllowedFlags(parsed, ['--head'])) {
        return null;
      }
      if (!jsonFieldsEqual(parsed.jsonFields, ['number'])) {
        return null;
      }
      const allowedJq = [null, '', '.[0].number'];
      if (parsed.jq && !allowedJq.includes(parsed.jq)) {
        return null;
      }
      return { id: 'pr-list-head', branch: headFlag };
    }

    if (!hasOnlyAllowedFlags(parsed, ['--state', '--limit'])) {
      return null;
    }
    if (parsed.flags['--state'] !== 'open') {
      return null;
    }
    const limit = parsed.flags['--limit'];
    if (limit && Number(limit) > 200) {
      return null;
    }
    const allowedFieldSets = [
      ['baseRefName', 'headRefOid', 'number'],
      ['headRefOid', 'number'],
    ];
    const matched = allowedFieldSets.find((set) => jsonFieldsEqual(parsed.jsonFields, set));
    if (!matched) {
      return null;
    }
    const allowedJq = [null, '', '.[0].number'];
    if (parsed.jq && !allowedJq.includes(parsed.jq)) {
      return null;
    }
    return { id: 'pr-list-open' };
  }

  if (sub === 'view') {
    if (!hasOnlyAllowedFlags(parsed, [])) {
      return null;
    }
    const prRef = parsed.positionals[0];
    if (!prRef) {
      return null;
    }
    const fields = parsed.jsonFields;
    if (!fields) {
      return null;
    }

    if (jsonFieldsEqual(fields, [...PR_INFO_FROM_VIEW_FIELDS])) {
      if (parsed.jq) {
        return null;
      }
      return { id: 'pr-view', prRef };
    }

    const num = Number(prRef);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }

    const allowedSets = [
      ['baseRefName'],
      ['body'],
      ['body', 'number'],
      ['baseRefName', 'headRefOid', 'number', 'state'],
      ['number', 'headRefOid', 'baseRefName', 'state'],
      ['mergedAt', 'state'],
      ['state'],
    ];
    const normalizedAllowed = allowedSets.map((s) => [...s].sort());
    const sorted = [...fields].sort();
    const matched = normalizedAllowed.find(
      (set) => set.length === sorted.length && set.every((f, i) => f === sorted[i]),
    );
    if (!matched) {
      return null;
    }

    const allowedJqByFields = {
      'baseRefName': ['.baseRefName'],
      'body': ['.body'],
      'body,number': ["{number: .number, body: .body}", '{number: .number, body: .body}'],
    };
    const key = [...fields].sort().join(',');
    if (parsed.jq) {
      const allowed = allowedJqByFields[key] ?? [];
      if (!allowed.includes(parsed.jq)) {
        return null;
      }
    }

    return { id: 'pr-view', prNumber: num };
  }

  return null;
}

/**
 * @param {string[]} argv
 */
export function classifyArgv(argv) {
  const parsed = parseGhArgv(argv);
  const route = matchInventoryRoute(parsed);
  return { parsed, route };
}
