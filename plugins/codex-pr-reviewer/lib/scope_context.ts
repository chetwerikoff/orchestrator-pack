import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findLatestMirrorIterationId,
  loadActiveDeclaration,
} from '../../scope-guard/lib/declaration_loader.ts';
import { parseIssueBody, type IssueConstraints } from '@orchestrator-pack/shared/lib/issue_parser.js';
import {
  extractLinkedIssueNumber,
  resolveLatestCommittedSnapshot,
} from '../../../scripts/pr-scope-check.ts';
import { resolveTrackedGhWrapper } from '../../../scripts/lib/gh-resolve-real-binary.mjs';
import { resolveNameWithOwner } from '../../../scripts/lib/gh-repo-resolve.mjs';

export interface ResolvedScopeContext {
  issueNumber: number | null;
  /** True when issue fences and/or a declaration snapshot are available for the prompt. */
  hasScope: boolean;
  issueConstraints: IssueConstraints | null;
  declaredPaths: string[];
  declaredGlobs: string[];
  unverifiedIssueConstraints: boolean;
}

const GH_TIMEOUT_MS = 10_000;

function shouldSkipGh(): boolean {
  return process.env.VITEST === 'true' || process.env.OPK_CODEX_REVIEW_SKIP_GH === '1';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportTrackedGhTransportFailure(error: unknown): void {
  process.stderr.write(`[codex-pr-reviewer] tracked GitHub transport unavailable: ${errorMessage(error)}\n`);
}

function readGhJsonBody(
  repoRoot: string,
  args: string[],
): Record<string, unknown> | null {
  if (shouldSkipGh()) {
    return null;
  }

  let command: string;
  try {
    command = resolveTrackedGhWrapper();
  } catch (error) {
    reportTrackedGhTransportFailure(error);
    return null;
  }

  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_TIMEOUT_MS,
    });
    return JSON.parse(output) as Record<string, unknown>;
  } catch (error) {
    reportTrackedGhTransportFailure(error);
    return null;
  }
}

function bodyFromGhJson(parsed: Record<string, unknown> | null): string | null {
  const body = parsed?.body;
  return typeof body === 'string' ? body : null;
}

function localRepoSlug(repoRoot: string): string | null {
  try {
    return resolveNameWithOwner({ cwd: repoRoot, realGh: resolveTrackedGhWrapper() });
  } catch (error) {
    reportTrackedGhTransportFailure(error);
    return null;
  }
}

function fetchIssueBody(repoRoot: string, issueNumber: number): string | null {
  const repoSlug = localRepoSlug(repoRoot);
  if (!repoSlug) return null;
  const parsed = readGhJsonBody(repoRoot, [
    'api',
    `repos/${repoSlug}/issues/${issueNumber}`,
  ]);
  return bodyFromGhJson(parsed);
}

function fetchPrBody(repoRoot: string, prNumber: number): string | null {
  const repoSlug = localRepoSlug(repoRoot);
  if (!repoSlug) return null;
  const parsed = readGhJsonBody(repoRoot, [
    'api',
    `repos/${repoSlug}/pulls/${prNumber}`,
  ]);
  return bodyFromGhJson(parsed);
}

function readPrBodyFromFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function resolveIssueNumber(options: {
  repoRoot: string;
  explicitIssue?: number;
  prBody?: string | null;
  prBodyFile?: string;
  prNumber?: number;
  env?: NodeJS.ProcessEnv;
}): number | null {
  if (options.explicitIssue !== undefined) {
    return options.explicitIssue;
  }

  let prBody = options.prBody ?? null;
  if (!prBody && options.prBodyFile) {
    prBody = readPrBodyFromFile(options.prBodyFile);
  }
  if (!prBody && options.prNumber !== undefined) {
    prBody = fetchPrBody(options.repoRoot, options.prNumber);
  }

  if (prBody) {
    return extractLinkedIssueNumber(prBody);
  }

  return null;
}

export function resolveScopeContext(options: {
  repoRoot: string;
  issueNumber: number | null;
}): ResolvedScopeContext {
  const empty: ResolvedScopeContext = {
    issueNumber: options.issueNumber,
    hasScope: false,
    issueConstraints: null,
    declaredPaths: [],
    declaredGlobs: [],
    unverifiedIssueConstraints: false,
  };

  if (options.issueNumber === null) {
    return empty;
  }

  let issueConstraints: IssueConstraints | null = null;
  let unverifiedIssueConstraints = false;
  const issueBody = fetchIssueBody(options.repoRoot, options.issueNumber);
  if (issueBody) {
    try {
      issueConstraints = parseIssueBody(issueBody);
    } catch {
      unverifiedIssueConstraints = true;
    }
  } else {
    unverifiedIssueConstraints = true;
  }

  let declaredPaths: string[] = [];
  let declaredGlobs: string[] = [];

  const mirrorIterationId = findLatestMirrorIterationId(options.repoRoot, options.issueNumber) ?? undefined;
  let declaration = mirrorIterationId
    ? loadActiveDeclaration(options.repoRoot, options.issueNumber, mirrorIterationId)
    : null;

  if (!declaration) {
    const committed = resolveLatestCommittedSnapshot(
      options.repoRoot,
      options.issueNumber,
    );
    if (committed.ok) {
      declaration = committed.snapshot;
    }
  }

  if (declaration) {
    declaredPaths = [...declaration.declared_paths];
    declaredGlobs = [...declaration.declared_globs];
  }

  const hasScope =
    issueConstraints !== null ||
    declaredPaths.length > 0 ||
    declaredGlobs.length > 0;

  return {
    issueNumber: options.issueNumber,
    hasScope,
    issueConstraints,
    declaredPaths,
    declaredGlobs,
    unverifiedIssueConstraints,
  };
}

export function formatScopeSection(scope: ResolvedScopeContext): string {
  if (!scope.hasScope) {
    return '_No active scope context (issue fences and declaration snapshot unavailable). Review code quality only; do not invent scope rules._';
  }

  const lines: string[] = [
    `Linked issue: #${scope.issueNumber}`,
    '',
    '### Issue constraints',
  ];

  if (scope.issueConstraints) {
    lines.push('```denylist');
    lines.push(...scope.issueConstraints.denylist);
    lines.push('```');
    if (scope.issueConstraints.allowed_roots?.length) {
      lines.push('```allowed-roots');
      lines.push(...scope.issueConstraints.allowed_roots);
      lines.push('```');
    }
  } else {
    lines.push('_Issue body constraints could not be loaded; treat denylist/allowed_roots as unverified._');
  }

  lines.push('', '### Active declaration snapshot');
  if (scope.declaredPaths.length === 0 && scope.declaredGlobs.length === 0) {
    lines.push('_No declaration snapshot found for this issue._');
  } else {
    lines.push('```declared-paths');
    lines.push(...scope.declaredPaths);
    lines.push('```');
    if (scope.declaredGlobs.length > 0) {
      lines.push('```declared-globs');
      lines.push(...scope.declaredGlobs);
      lines.push('```');
    }
  }

  return lines.join('\n');
}

export function scopeUnavailableWarningFinding(
  source: import('./types.ts').ReviewSource,
): import('./types.ts').StructuredFinding {
  return {
    type: 'spec',
    code: 'scope-context-unavailable',
    severity: 'non-blocking',
    path: null,
    summary: 'Scope context unavailable (no issue denylist fence and no declaration snapshot)',
    details:
      'Review proceeded without authoritative scope. Declare scope via issue body fences and pack-declare snapshot before relying on scope-violation findings.',
    source,
  };
}
