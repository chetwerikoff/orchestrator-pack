import { execFileSync } from 'node:child_process';
import { parseIssueBody } from '@orchestrator-pack/shared/lib/issue_parser.js';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';

/** Pack-standard denylist used when gh is unavailable (hook-only mode). */
export const FALLBACK_DENYLIST = [
  'vendor/**',
  'packages/core/**',
  '.ao/**',
] as const;

function normalizeDenylistPatterns(patterns: string[]): string[] {
  const normalized: string[] = [];
  for (const pattern of patterns) {
    const result = normalizePath(pattern);
    if (!result.ok) {
      throw new Error(`invalid denylist pattern "${pattern}": ${result.reason}`);
    }
    normalized.push(result.path);
  }
  return normalized;
}

/** Max time to wait for gh when resolving issue denylist (ms). */
const GH_ISSUE_VIEW_TIMEOUT_MS = 3_000;

function shouldSkipGhIssueLookup(): boolean {
  // Vitest sets VITEST=true; avoid slow/flaky gh calls in contract tests.
  return process.env.VITEST === 'true' || process.env.AO_SCOPE_GUARD_SKIP_GH === '1';
}

function fetchIssueDenylist(repoRoot: string, issueNumber: number): string[] | null {
  if (shouldSkipGhIssueLookup()) {
    return null;
  }

  try {
    const output = execFileSync(
      'gh',
      ['issue', 'view', String(issueNumber), '--json', 'body'],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GH_ISSUE_VIEW_TIMEOUT_MS,
      },
    );
    const parsed = JSON.parse(output) as { body?: string };
    if (typeof parsed.body !== 'string') {
      return null;
    }
    return parseIssueBody(parsed.body).denylist;
  } catch {
    return null;
  }
}

/**
 * Resolve issue denylist for runtime checks. Prefers gh issue body; falls back
 * to the pack-standard list so hooks work without AO or gh.
 */
export function resolveIssueDenylist(
  repoRoot: string,
  issueNumber: number,
): string[] {
  const fromIssue = fetchIssueDenylist(repoRoot, issueNumber);
  const patterns = fromIssue ?? [...FALLBACK_DENYLIST];
  return normalizeDenylistPatterns(patterns);
}
