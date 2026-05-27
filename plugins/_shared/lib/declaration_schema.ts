export type IterationIdSource = 'ao_session' | 'wrapper_generated';

export interface DeclarationBaseline {
  commit_sha: string;
  worktree_dirty: boolean;
  active_scope_hash: string;
}

export interface DeclarationAmendment {
  previous_active_scope_hash: string;
  new_active_scope_hash: string;
  changed: { added: string[]; removed: string[] };
  reason: string;
  actor: string;
  timestamp: string;
  applied: boolean;
}

export interface DeclarationSnapshot {
  issue_number: number;
  iteration_id: string;
  iteration_id_source: IterationIdSource;
  supersedes: string | null;
  created_at: string;
  baseline: DeclarationBaseline;
  declared_paths: string[];
  declared_globs: string[];
  amendments: DeclarationAmendment[];
}

export type SchemaValidationResult =
  | { ok: true; snapshot: DeclarationSnapshot }
  | { ok: false; errors: string[] };

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Validate a committed declaration snapshot against #3.A metadata requirements.
 */
export function validateDeclarationSnapshot(
  input: unknown,
): SchemaValidationResult {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ['snapshot must be a JSON object'] };
  }

  if (typeof input.issue_number !== 'number' || !Number.isInteger(input.issue_number)) {
    errors.push('issue_number must be an integer');
  }

  if (typeof input.iteration_id !== 'string' || !input.iteration_id.trim()) {
    errors.push('iteration_id must be a non-empty string');
  }

  const source = input.iteration_id_source;
  if (source !== 'ao_session' && source !== 'wrapper_generated') {
    errors.push('iteration_id_source must be "ao_session" or "wrapper_generated"');
  }

  if (input.supersedes !== null && typeof input.supersedes !== 'string') {
    errors.push('supersedes must be a string or null');
  }

  if (typeof input.created_at !== 'string' || !ISO_8601.test(input.created_at)) {
    errors.push('created_at must be an ISO 8601 timestamp string');
  }

  if (!isRecord(input.baseline)) {
    errors.push('baseline must be an object');
  } else {
    const b = input.baseline;
    if (typeof b.commit_sha !== 'string' || !b.commit_sha.trim()) {
      errors.push('baseline.commit_sha must be a non-empty string');
    }
    if (typeof b.worktree_dirty !== 'boolean') {
      errors.push('baseline.worktree_dirty must be a boolean');
    }
    if (typeof b.active_scope_hash !== 'string' || !b.active_scope_hash.startsWith('sha256:')) {
      errors.push('baseline.active_scope_hash must be a sha256: prefixed string');
    }
  }

  if (!isStringArray(input.declared_paths)) {
    errors.push('declared_paths must be an array of strings');
  }

  if (!isStringArray(input.declared_globs)) {
    errors.push('declared_globs must be an array of strings');
  }

  if (!Array.isArray(input.amendments)) {
    errors.push('amendments must be an array');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, snapshot: input as DeclarationSnapshot };
}
