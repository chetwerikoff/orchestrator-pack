import { execFileSync, spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRemoteSlug, RESOLVER_GIT_ARGV } from './git-origin-slug.mjs';

export { RESOLVER_GIT_ARGV };

const __dirname = dirname(fileURLToPath(import.meta.url));
const RATE_LIMIT_HEADER_NAMES = new Set([
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
]);
let lastGhApiRateLimitHeaders = {};

/**
 * @param {string} realGh
 * @param {string | null} hostname
 */
function readGhHostname(realGh, hostname) {
  if (hostname) {
    return hostname;
  }
  if (process.env.GH_HOST) {
    return process.env.GH_HOST;
  }
  try {
    const args = ['config', 'get', 'hostname'];
    if (process.env.GH_HOST) {
      args.unshift('--hostname', process.env.GH_HOST);
    }
    const out = execFileSync(realGh, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out || 'github.com';
  } catch {
    return 'github.com';
  }
}

/**
 * @param {string} cwd
 */
function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * @param {string} repoRoot
 */
function gitOriginSlug(repoRoot) {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return parseRemoteSlug(url);
  } catch {
    return null;
  }
}

/**
 * @param {string | null | undefined} repoFlag
 */
function parseRepoFlag(repoFlag) {
  if (!repoFlag) {
    return null;
  }
  const trimmed = repoFlag.trim();
  if (!trimmed.includes('/')) {
    return null;
  }
  const [owner, repo] = trimmed.split('/');
  if (!owner || !repo) {
    return null;
  }
  return `${owner}/${repo}`;
}

/**
 * @param {{ cwd?: string, repoFlag?: string | null, realGh: string, hostname?: string | null }} options
 * @returns {{ slug: string, host: string }}
 */
export function resolveRepoContext(options) {
  const cwd = options.cwd ?? process.cwd();
  const host = readGhHostname(options.realGh, options.hostname ?? null);

  const flagRepo = parseRepoFlag(options.repoFlag ?? null);
  if (flagRepo) {
    return { slug: flagRepo, host };
  }

  const envRepo = process.env.GH_REPO ? parseRepoFlag(process.env.GH_REPO) : null;
  if (envRepo) {
    return { slug: envRepo, host };
  }

  const top = gitToplevel(cwd);
  const gitSlug = top ? gitOriginSlug(top) : null;
  if (gitSlug) {
    return { slug: gitSlug, host };
  }

  throw new Error('gh-wrapper: could not resolve repository slug');
}

/**
 * Local derivation for gh repo view --json nameWithOwner (no network).
 * @param {{ cwd?: string, repoFlag?: string | null, realGh: string, hostname?: string | null }} options
 */
export function resolveNameWithOwner(options) {
  return resolveRepoContext(options).slug;
}

/**
 * @param {object} data
 * @param {string[]} fields
 */
export function pickJsonFields(data, fields) {
  const out = {};
  for (const field of fields) {
    out[field] = data[field] ?? null;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string | null} jq
 */
export function applyListedJq(value, jq) {
  if (!jq) {
    return value;
  }
  const normalized = jq.trim();
  if (normalized === '.baseRefName') {
    return value.baseRefName;
  }
  if (normalized === '.body') {
    return value.body;
  }
  if (normalized === '.nameWithOwner') {
    return value.nameWithOwner;
  }
  if (normalized === '.[0].number') {
    return Array.isArray(value) && value.length > 0 ? value[0].number : null;
  }
  if (normalized === '{number: .number, body: .body}' || normalized === "{number: .number, body: .body}") {
    return { number: value.number, body: value.body };
  }
  throw new Error(`gh-wrapper: unsupported jq expression: ${jq}`);
}

/**
 * @param {string} text
 * @returns {{ body: string, rateLimitHeaders: Record<string, string> }}
 */
function splitGhApiIncludeOutput(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let headerStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^HTTP\/\d(?:\.\d)?\s+\d+/.test(lines[i])) {
      headerStart = i;
    }
  }
  if (headerStart < 0) {
    return { body: normalized, rateLimitHeaders: {} };
  }

  let bodyStart = headerStart + 1;
  const headers = {};
  for (let i = headerStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      bodyStart = i + 1;
      break;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) {
      continue;
    }
    const name = line.slice(0, idx).trim().toLowerCase();
    if (RATE_LIMIT_HEADER_NAMES.has(name)) {
      headers[name] = line.slice(idx + 1).trim();
    }
  }

  return { body: lines.slice(bodyStart).join('\n'), rateLimitHeaders: headers };
}

export function consumeGhApiRateLimitHeaders() {
  const out = lastGhApiRateLimitHeaders;
  lastGhApiRateLimitHeaders = {};
  return out;
}

/**
 * @param {string} realGh
 * @param {string} endpoint
 * @param {{ hostname?: string | null, cwd?: string }} options
 */
export function ghApiJson(realGh, endpoint, options = {}) {
  const args = ['api', endpoint, '--include'];
  if (options.hostname) {
    args.unshift('--hostname', options.hostname);
  }
  const result = spawnSync(realGh, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, GH_WRAPPER_ACTIVE: '1' },
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = splitGhApiIncludeOutput(result.stdout);
  if (Object.keys(parsed.rateLimitHeaders).length > 0) {
    lastGhApiRateLimitHeaders = {
      ...lastGhApiRateLimitHeaders,
      ...parsed.rateLimitHeaders,
    };
  }
  if (result.status !== 0) {
    const err = (result.stderr || parsed.body || result.stdout || '').trim() || `gh api failed (exit ${result.status})`;
    throw new Error(err);
  }
  return JSON.parse(parsed.body);
}

/**
 * Map REST pull state to gh pr view state enum.
 * @param {Record<string, unknown>} pull
 */
export function mapPullState(pull) {
  if (pull.merged_at) {
    return 'MERGED';
  }
  if (pull.state === 'closed') {
    return 'CLOSED';
  }
  return 'OPEN';
}

/**
 * @param {Record<string, unknown>} pull
 * @param {string[]} fields
 */
export function mapPullToGhJson(pull, fields) {
  const base = {
    number: pull.number,
    title: pull.title ?? '',
    url: pull.html_url ?? null,
    headRefOid: pull.head?.sha ?? null,
    headRefName: pull.head?.ref ?? null,
    baseRefName: pull.base?.ref ?? null,
    isDraft: pull.draft ?? false,
    state: mapPullState(pull),
    mergedAt: pull.merged_at ?? null,
    body: pull.body ?? '',
  };
  return pickJsonFields(base, fields);
}


/**
 * Map REST issue state to gh issue view state enum.
 * @param {Record<string, unknown>} issue
 */
export function mapIssueState(issue) {
  if (issue.state === 'closed') {
    return 'CLOSED';
  }
  return 'OPEN';
}

/** @type {Record<string, string>} */
const ISSUE_STATE_REASON_MAP = {
  completed: 'COMPLETED',
  not_planned: 'NOT_PLANNED',
  reopened: 'REOPENED',
  duplicate: 'DUPLICATE',
};

/**
 * Map REST issue state_reason to gh issue view stateReason enum.
 * @param {Record<string, unknown>} issue
 */
export function mapIssueStateReason(issue) {
  const raw = issue.state_reason;
  if (raw == null || raw === '') {
    return null;
  }
  return ISSUE_STATE_REASON_MAP[String(raw).toLowerCase()] ?? null;
}

/**
 * @param {Record<string, unknown>} issue
 * @param {string[]} fields
 */
export function mapIssueToGhJson(issue, fields) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => ({ name: label?.name ?? null }))
    : [];
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.map((assignee) => ({ login: assignee?.login ?? null }))
    : [];
  const base = {
    number: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    url: issue.html_url ?? null,
    state: mapIssueState(issue),
    stateReason: mapIssueStateReason(issue),
    closedAt: issue.closed_at ?? null,
    labels,
    assignees,
  };
  return pickJsonFields(base, fields);
}

export const REST_ERROR_MARKER = 'gh-wrapper: REST route failed';
