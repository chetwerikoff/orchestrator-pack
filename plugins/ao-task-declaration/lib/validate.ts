import { normalizePath, normalizePaths } from '@orchestrator-pack/shared/lib/normalize.js';
import type { IssueConstraints } from '@orchestrator-pack/shared/lib/issue_parser.js';
import {
  globIsWithinAllowedRoot,
  globPatternsOverlap,
  pathMatchesAnyPattern,
} from './glob_match.js';

export interface DeclaredScopeInput {
  declared_paths: string[];
  declared_globs: string[];
}

export type ValidateScopeResult =
  | { ok: true; declared_paths: string[]; declared_globs: string[] }
  | { ok: false; errors: string[] };

function normalizeConstraintPatterns(
  patterns: string[],
  field: string,
): { ok: true; patterns: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const normalized: string[] = [];

  for (const [index, pattern] of patterns.entries()) {
    const result = normalizePath(pattern);
    if (!result.ok) {
      errors.push(`${field}[${index}]: ${result.reason}`);
      continue;
    }
    normalized.push(result.path);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, patterns: normalized };
}

/**
 * Enforce declaration-time constraints from #3.A against issue body fences.
 */
export function validateDeclaredScope(
  input: DeclaredScopeInput,
  constraints: IssueConstraints,
): ValidateScopeResult {
  const errors: string[] = [];

  const normalizedPaths = normalizePaths(input.declared_paths);
  if (!normalizedPaths.ok) {
    return { ok: false, errors: [`declared_paths: ${normalizedPaths.reason}`] };
  }

  const normalizedGlobs = normalizePaths(input.declared_globs);
  if (!normalizedGlobs.ok) {
    return { ok: false, errors: [`declared_globs: ${normalizedGlobs.reason}`] };
  }

  const denylist = normalizeConstraintPatterns(constraints.denylist, 'issue.denylist');
  if (!denylist.ok) {
    return { ok: false, errors: denylist.errors };
  }

  let allowedRoots: string[] | undefined;
  if (constraints.allowed_roots !== undefined) {
    const roots = normalizeConstraintPatterns(
      constraints.allowed_roots,
      'issue.allowed_roots',
    );
    if (!roots.ok) {
      return { ok: false, errors: roots.errors };
    }
    allowedRoots = roots.patterns;
  }

  for (const [index, path] of normalizedPaths.paths.entries()) {
    if (pathMatchesAnyPattern(path, denylist.patterns)) {
      errors.push(
        `declared_paths[${index}] "${path}" intersects issue denylist`,
      );
    }

    if (allowedRoots !== undefined && !pathMatchesAnyPattern(path, allowedRoots)) {
      errors.push(
        `declared_paths[${index}] "${path}" is outside issue allowed_roots`,
      );
    }
  }

  for (const [index, glob] of normalizedGlobs.paths.entries()) {
    for (const denied of denylist.patterns) {
      if (globPatternsOverlap(glob, denied)) {
        errors.push(
          `declared_globs[${index}] "${glob}" intersects issue denylist "${denied}"`,
        );
      }
    }

    if (allowedRoots !== undefined) {
      const withinRoot = allowedRoots.some((root) =>
        globIsWithinAllowedRoot(glob, root),
      );
      if (!withinRoot) {
        errors.push(
          `declared_globs[${index}] "${glob}" is outside issue allowed_roots`,
        );
      }
    }
  }

  if (normalizedPaths.paths.length === 0 && normalizedGlobs.paths.length === 0) {
    errors.push('declaration must include at least one declared_paths or declared_globs entry');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    declared_paths: normalizedPaths.paths,
    declared_globs: normalizedGlobs.paths,
  };
}

export function normalizeIssueConstraints(
  constraints: IssueConstraints,
): IssueConstraints {
  const denylist = normalizeConstraintPatterns(constraints.denylist, 'issue.denylist');
  if (!denylist.ok) {
    throw new Error(denylist.errors.join('; '));
  }

  const normalized: IssueConstraints = { denylist: denylist.patterns };
  if (constraints.allowed_roots !== undefined) {
    const roots = normalizeConstraintPatterns(
      constraints.allowed_roots,
      'issue.allowed_roots',
    );
    if (!roots.ok) {
      throw new Error(roots.errors.join('; '));
    }
    normalized.allowed_roots = roots.patterns;
  }

  return normalized;
}
