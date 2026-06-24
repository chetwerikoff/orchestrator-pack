import { jsonFieldsEqual, parseGhArgv } from './gh-parse-argv.mjs';

/** @typedef {'pr-list-open' | 'pr-list-head' | 'pr-view' | 'pr-checks' | 'pr-diff-name-only' | 'issue-view-body' | 'repo-view-name-with-owner'} InventoryRouteId */

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
    if (!jsonFieldsEqual(parsed.jsonFields, ['nameWithOwner'])) {
      return null;
    }
    if (parsed.jq && parsed.jq !== '.nameWithOwner') {
      return null;
    }
    return { id: 'repo-view-name-with-owner' };
  }

  if (root === 'issue' && sub === 'view') {
    const num = Number(parsed.positionals[0]);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    if (!jsonFieldsEqual(parsed.jsonFields, ['body'])) {
      return null;
    }
    if (parsed.jq && parsed.jq !== '.body') {
      return null;
    }
    return { id: 'issue-view-body', prNumber: num };
  }

  if (root !== 'pr') {
    return null;
  }

  if (sub === 'diff') {
    const num = Number(parsed.positionals[0]);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    if (parsed.flags['--name-only'] !== true && parsed.flags['--name-only'] !== 'true') {
      return null;
    }
    if (Object.keys(parsed.flags).some((k) => k !== '--name-only' && k !== '--repo' && k !== '-R')) {
      if (parsed.jsonFields || parsed.jq) {
        return null;
      }
    }
    return { id: 'pr-diff-name-only', prNumber: num };
  }

  if (sub === 'checks') {
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
    if (parsed.flags['--required']) {
      return null;
    }
    return { id: 'pr-checks', prNumber: num };
  }

  if (sub === 'list') {
    const headFlag = parsed.flags['--head'];
    if (headFlag && typeof headFlag === 'string') {
      if (!jsonFieldsEqual(parsed.jsonFields, ['number'])) {
        return null;
      }
      const allowedJq = [null, '', '.[0].number'];
      if (parsed.jq && !allowedJq.includes(parsed.jq)) {
        return null;
      }
      if (parsed.flags['--state']) {
        return null;
      }
      return { id: 'pr-list-head', branch: headFlag };
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
    const num = Number(parsed.positionals[0]);
    if (!Number.isFinite(num) || num <= 0) {
      return null;
    }
    const fields = parsed.jsonFields;
    if (!fields) {
      return null;
    }

    const allowedSets = [
      ['baseRefName'],
      ['body'],
      ['body', 'number'],
      ['baseRefName', 'headRefOid', 'number', 'state'],
      ['number', 'headRefOid', 'baseRefName', 'state'],
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
