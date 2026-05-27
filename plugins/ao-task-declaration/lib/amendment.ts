import type {
  DeclarationAmendment,
  DeclarationSnapshot,
} from '@orchestrator-pack/shared/lib/declaration_schema.js';
import type { IssueConstraints } from '@orchestrator-pack/shared/lib/issue_parser.js';
import { computeActiveScopeHash } from './baseline.js';
import { validateDeclaredScope } from './validate.js';

export interface AmendmentInput {
  declared_paths: string[];
  declared_globs: string[];
  reason: string;
  actor: string;
}

export type ApplyAmendmentResult =
  | { ok: true; snapshot: DeclarationSnapshot }
  | { ok: false; error: string };

function diffScope(
  previousPaths: string[],
  previousGlobs: string[],
  nextPaths: string[],
  nextGlobs: string[],
): { added: string[]; removed: string[] } {
  const previous = new Set([...previousPaths, ...previousGlobs]);
  const next = new Set([...nextPaths, ...nextGlobs]);
  const added = [...next].filter((entry) => !previous.has(entry)).sort();
  const removed = [...previous].filter((entry) => !next.has(entry)).sort();
  return { added, removed };
}

/**
 * Apply the single allowed amendment for an iteration (#3.A).
 */
export function applyAmendment(
  existing: DeclarationSnapshot,
  input: AmendmentInput,
  constraints: IssueConstraints,
): ApplyAmendmentResult {
  if (existing.amendments.length >= 1) {
    return {
      ok: false,
      error:
        'amendment rejected: one amendment per iteration_id has already been recorded',
    };
  }

  const validated = validateDeclaredScope(
    {
      declared_paths: input.declared_paths,
      declared_globs: input.declared_globs,
    },
    constraints,
  );

  if (!validated.ok) {
    return { ok: false, error: validated.errors.join('; ') };
  }

  const previousHash = existing.baseline.active_scope_hash;
  const nextHash = computeActiveScopeHash({
    declared_paths: validated.declared_paths,
    declared_globs: validated.declared_globs,
    issue_denylist: constraints.denylist,
    issue_allowed_roots: constraints.allowed_roots,
  });

  const amendment: DeclarationAmendment = {
    previous_active_scope_hash: previousHash,
    new_active_scope_hash: nextHash,
    changed: diffScope(
      existing.declared_paths,
      existing.declared_globs,
      validated.declared_paths,
      validated.declared_globs,
    ),
    reason: input.reason.trim(),
    actor: input.actor.trim(),
    timestamp: new Date().toISOString(),
    applied: true,
  };

  if (!amendment.reason) {
    return { ok: false, error: 'amendment reason must be non-empty' };
  }

  if (!amendment.actor) {
    return { ok: false, error: 'amendment actor must be non-empty' };
  }

  return {
    ok: true,
    snapshot: {
      ...existing,
      declared_paths: validated.declared_paths,
      declared_globs: validated.declared_globs,
      baseline: {
        ...existing.baseline,
        active_scope_hash: nextHash,
      },
      amendments: [amendment],
    },
  };
}

export function assertAmendmentAllowed(existing: DeclarationSnapshot): void {
  if (existing.amendments.length >= 1) {
    throw new Error(
      'amendment rejected: one amendment per iteration_id has already been recorded',
    );
  }
}
