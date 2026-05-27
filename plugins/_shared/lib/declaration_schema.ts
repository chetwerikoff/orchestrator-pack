import { normalizePath } from './normalize.js';

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

const MAX_AMENDMENTS_PER_ITERATION = 1;

function isScopeHash(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('sha256:') && value.length > 'sha256:'.length;
}

function validateAmendmentEntries(amendments: unknown): string[] {
  const errors: string[] = [];

  if (!Array.isArray(amendments)) {
    return ['amendments must be an array'];
  }

  if (amendments.length > MAX_AMENDMENTS_PER_ITERATION) {
    errors.push(
      `amendments must contain at most ${MAX_AMENDMENTS_PER_ITERATION} entry per iteration`,
    );
  }

  amendments.forEach((entry, index) => {
    const prefix = `amendments[${index}]`;

    if (!isRecord(entry)) {
      errors.push(`${prefix}: must be an object`);
      return;
    }

    if (!isScopeHash(entry.previous_active_scope_hash)) {
      errors.push(`${prefix}.previous_active_scope_hash must be a sha256: prefixed string`);
    }

    if (!isScopeHash(entry.new_active_scope_hash)) {
      errors.push(`${prefix}.new_active_scope_hash must be a sha256: prefixed string`);
    }

    if (!isRecord(entry.changed)) {
      errors.push(`${prefix}.changed must be an object`);
    } else {
      if (!isStringArray(entry.changed.added)) {
        errors.push(`${prefix}.changed.added must be an array of strings`);
      } else {
        errors.push(
          ...validateNormalizedScopeEntries(
            entry.changed.added,
            `${prefix}.changed.added`,
          ),
        );
      }
      if (!isStringArray(entry.changed.removed)) {
        errors.push(`${prefix}.changed.removed must be an array of strings`);
      } else {
        errors.push(
          ...validateNormalizedScopeEntries(
            entry.changed.removed,
            `${prefix}.changed.removed`,
          ),
        );
      }
    }

    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      errors.push(`${prefix}.reason must be a non-empty string`);
    }

    if (typeof entry.actor !== 'string' || !entry.actor.trim()) {
      errors.push(`${prefix}.actor must be a non-empty string`);
    }

    if (typeof entry.timestamp !== 'string' || !ISO_8601.test(entry.timestamp)) {
      errors.push(`${prefix}.timestamp must be an ISO 8601 timestamp string`);
    }

    if (typeof entry.applied !== 'boolean') {
      errors.push(`${prefix}.applied must be a boolean`);
    } else if (entry.applied !== true) {
      errors.push(`${prefix}.applied must be true for committed amendments`);
    }
  });

  return errors;
}

function validateNormalizedScopeEntries(
  entries: string[],
  field: string,
): string[] {
  const errors: string[] = [];
  entries.forEach((entry, index) => {
    const normalized = normalizePath(entry);
    if (!normalized.ok) {
      errors.push(`${field}[${index}]: ${normalized.reason}`);
      return;
    }
    if (normalized.path !== entry) {
      errors.push(
        `${field}[${index}]: must be a normalized relative path (got "${entry}")`,
      );
    }
  });
  return errors;
}

function buildSnapshot(input: Record<string, unknown>): DeclarationSnapshot {
  const baseline = input.baseline as Record<string, unknown>;
  return {
    issue_number: input.issue_number as number,
    iteration_id: input.iteration_id as string,
    iteration_id_source: input.iteration_id_source as IterationIdSource,
    supersedes: input.supersedes as string | null,
    created_at: input.created_at as string,
    baseline: {
      commit_sha: baseline.commit_sha as string,
      worktree_dirty: baseline.worktree_dirty as boolean,
      active_scope_hash: baseline.active_scope_hash as string,
    },
    declared_paths: input.declared_paths as string[],
    declared_globs: input.declared_globs as string[],
    amendments: input.amendments as DeclarationAmendment[],
  };
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
  } else {
    errors.push(...validateNormalizedScopeEntries(input.declared_paths, 'declared_paths'));
  }

  if (!isStringArray(input.declared_globs)) {
    errors.push('declared_globs must be an array of strings');
  } else {
    errors.push(...validateNormalizedScopeEntries(input.declared_globs, 'declared_globs'));
  }

  errors.push(...validateAmendmentEntries(input.amendments));

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, snapshot: buildSnapshot(input) };
}
