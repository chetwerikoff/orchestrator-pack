import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLatestActiveDeclaration } from '../../ao-scope-guard/lib/declaration_loader.js';
import { parseIssueBody, type IssueConstraints } from '@orchestrator-pack/shared/lib/issue_parser.js';
import {
  extractLinkedIssueNumber,
  resolveLatestCommittedSnapshot,
} from '../../../scripts/pr-scope-check.js';

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
  return process.env.VITEST === 'true' || process.env.AO_CODEX_REVIEW_SKIP_GH === '1';
}

function fetchIssueBody(repoRoot: string, issueNumber: number): string | null {
  if (shouldSkipGh()) {
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
        timeout: GH_TIMEOUT_MS,
      },
    );
    const parsed = JSON.parse(output) as { body?: string };
    return typeof parsed.body === 'string' ? parsed.body : null;
  } catch {
    return null;
  }
}

function fetchPrBody(repoRoot: string, prNumber: number): string | null {
  if (shouldSkipGh()) {
    return null;
  }

  try {
    const output = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'body'],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GH_TIMEOUT_MS,
      },
    );
    const parsed = JSON.parse(output) as { body?: string };
    return typeof parsed.body === 'string' ? parsed.body : null;
  } catch {
    return null;
  }
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
  const env = options.env ?? process.env;
  if (options.explicitIssue !== undefined) {
    return options.explicitIssue;
  }

  const fromEnv = Number(env.AO_ISSUE_NUMBER ?? env.AO_ISSUE_ID);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
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
  const active = loadLatestActiveDeclaration(options.repoRoot, options.issueNumber);
  if (active) {
    declaredPaths = [...active.declared_paths];
    declaredGlobs = [...active.declared_globs];
  } else {
    const committed = resolveLatestCommittedSnapshot(options.repoRoot, options.issueNumber);
    if (committed.ok) {
      declaredPaths = [...committed.snapshot.declared_paths];
      declaredGlobs = [...committed.snapshot.declared_globs];
    }
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
  source: import('./types.js').ReviewSource,
): import('./types.js').StructuredFinding {
  return {
    type: 'spec',
    code: 'scope-context-unavailable',
    severity: 'non-blocking',
    path: null,
    summary: 'Scope context unavailable (no issue denylist fence and no declaration snapshot)',
    details:
      'Review proceeded without authoritative scope. Declare scope via issue body fences and ao-declare snapshot before relying on scope-violation findings.',
    source,
  };
}
