import type { DeclarationSnapshot } from '@orchestrator-pack/shared/lib/declaration_schema.js';
import { normalizePath } from '@orchestrator-pack/shared/lib/normalize.js';
import { partitionControlArtifacts } from './control_artifacts.js';
import { pathMatchesAnyPattern } from './glob_match.js';

export interface ScopeViolationReport {
  ok: false;
  reason:
    | 'scope_violation'
    | 'missing_declaration'
    | 'invalid_path';
  active_scope_hash?: string;
  baseline_commit_sha?: string;
  out_of_scope: string[];
  denied: string[];
  invalid_paths: Array<{ path: string; reason: string }>;
  skipped_control_artifacts: string[];
  message: string;
}

export type ScopeCheckResult =
  | { ok: true; skipped_control_artifacts: string[]; checked_paths: string[] }
  | ScopeViolationReport;

function pathInDeclaredScope(
  path: string,
  declaredPaths: string[],
  declaredGlobs: string[],
): boolean {
  if (declaredPaths.includes(path)) {
    return true;
  }
  return pathMatchesAnyPattern(path, declaredGlobs);
}

/**
 * Validate non-control paths against active declaration and issue denylist.
 */
export function checkScope(
  rawPaths: string[],
  declaration: DeclarationSnapshot | null,
  denylist: string[],
): ScopeCheckResult {
  const { control, scoped } = partitionControlArtifacts(rawPaths);

  if (scoped.length === 0) {
    return {
      ok: true,
      skipped_control_artifacts: control,
      checked_paths: [],
    };
  }

  if (!declaration) {
    return {
      ok: false,
      reason: 'missing_declaration',
      out_of_scope: scoped,
      denied: [],
      invalid_paths: [],
      skipped_control_artifacts: control,
      message:
        'no active declaration for the current iteration; mixed control-artifact and scoped changes require a declaration',
    };
  }

  const outOfScope: string[] = [];
  const denied: string[] = [];
  const invalidPaths: Array<{ path: string; reason: string }> = [];
  const checkedPaths: string[] = [];

  for (const rawPath of scoped) {
    const normalized = normalizePath(rawPath);
    if (!normalized.ok) {
      invalidPaths.push({ path: rawPath, reason: normalized.reason });
      continue;
    }

    checkedPaths.push(normalized.path);

    if (pathMatchesAnyPattern(normalized.path, denylist)) {
      denied.push(normalized.path);
      continue;
    }

    if (
      !pathInDeclaredScope(
        normalized.path,
        declaration.declared_paths,
        declaration.declared_globs,
      )
    ) {
      outOfScope.push(normalized.path);
    }
  }

  if (invalidPaths.length > 0) {
    return {
      ok: false,
      reason: 'invalid_path',
      active_scope_hash: declaration.baseline.active_scope_hash,
      baseline_commit_sha: declaration.baseline.commit_sha,
      out_of_scope: outOfScope,
      denied,
      invalid_paths: invalidPaths,
      skipped_control_artifacts: control,
      message: 'one or more changed paths failed normalization',
    };
  }

  if (outOfScope.length > 0 || denied.length > 0) {
    return {
      ok: false,
      reason: 'scope_violation',
      active_scope_hash: declaration.baseline.active_scope_hash,
      baseline_commit_sha: declaration.baseline.commit_sha,
      out_of_scope: outOfScope.sort(),
      denied: denied.sort(),
      invalid_paths: [],
      skipped_control_artifacts: control,
      message: 'one or more changed paths are outside active scope or denylisted',
    };
  }

  return {
    ok: true,
    skipped_control_artifacts: control,
    checked_paths: checkedPaths,
  };
}

export function formatViolationReport(report: ScopeViolationReport): string {
  return JSON.stringify(report, null, 2);
}
