import { readFileSync } from 'node:fs';
import type { GhTransport } from './lib/create-issue-stage-record-types.ts';
import {
  MIGRATION_SCHEMA,
  buildRecordMarker,
  canonicalJson,
  sha256,
  type ParsedRecordMarker,
} from './lib/create-issue-stage-topology.ts';
import {
  createCommentCensus,
  publishAfterCensus,
  type CommentPublicationResult,
} from './lib/create-issue-comment-census.ts';

export const PARKED_MIGRATION_ISSUES = [1168, 1173, 1188] as const;
export type ParkedMigrationIssue = typeof PARKED_MIGRATION_ISSUES[number];

export interface ParkedMigrationComment {
  id: number;
  body: string;
  byteLength: number;
  sha256: string;
}

export interface ParkedMigrationManifest {
  schema: typeof MIGRATION_SCHEMA;
  issueNumber: ParkedMigrationIssue;
  sourceRevision: string;
  migrationKind: 'field-complete' | 'legacy-cycle-settled' | 'cross-revision-lineage';
  pinnedComments: ParkedMigrationComment[];
  issueBody?: string;
  issueBodySha256?: string;
  dependency?: string;
  closure?: string;
  compiledAt?: string;
}

export interface ParkedMigrationImport extends ParkedMigrationManifest {
  eventKey: string;
  recordKey: string;
  body: string;
}

export const FIXED_MIGRATION_INPUTS: Record<ParkedMigrationIssue, {
  sourceRevision: string;
  migrationKind: ParkedMigrationManifest['migrationKind'];
  commentIds: number[];
  dependency?: string;
  closure?: string;
}> = {
  1168: {
    sourceRevision: 'r11',
    migrationKind: 'field-complete',
    commentIds: [5153515969, 5153516059, 5153516169, 5153567718, 5153568723],
  },
  1173: {
    sourceRevision: 'r01',
    migrationKind: 'legacy-cycle-settled',
    commentIds: [5152880935, 5152950548],
    dependency: '#1186',
    closure: 'completed-cycle-status;final-acceptance-outstanding',
  },
  1188: {
    sourceRevision: 'r03',
    migrationKind: 'cross-revision-lineage',
    commentIds: [5153107748, 5153180834],
    closure: 'one-way-cross-revision-lineage',
  },
};

function manifestError(message: string): never {
  throw new Error(`parked migration: ${message}`);
}

export function validateParkedMigrationManifest(value: unknown): ParkedMigrationManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) manifestError('manifest must be an object');
  const manifest = value as Partial<ParkedMigrationManifest>;
  if (manifest.schema !== MIGRATION_SCHEMA) manifestError('invalid schema');
  if (!PARKED_MIGRATION_ISSUES.includes(manifest.issueNumber as ParkedMigrationIssue)) manifestError('issue is not allowlisted');
  const fixed = FIXED_MIGRATION_INPUTS[manifest.issueNumber as ParkedMigrationIssue]!;
  if (manifest.sourceRevision !== fixed.sourceRevision || manifest.migrationKind !== fixed.migrationKind) {
    manifestError('fixed migration identity mismatch');
  }
  if (!Array.isArray(manifest.pinnedComments)) manifestError('pinned comments are required');
  const expectedIds = [...fixed.commentIds].sort((a, b) => a - b);
  const actualIds = manifest.pinnedComments.map((comment) => Number(comment?.id)).sort((a, b) => a - b);
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) manifestError('fixed comment set mismatch');
  for (const comment of manifest.pinnedComments) {
    if (!Number.isSafeInteger(comment.id) || typeof comment.body !== 'string' || comment.body.length === 0) manifestError('pinned comment is incomplete');
    const bytes = Buffer.from(comment.body, 'utf8');
    if (comment.byteLength !== bytes.byteLength || comment.sha256 !== sha256(bytes)) manifestError(`pinned comment ${comment.id} digest mismatch`);
  }
  if (fixed.dependency && manifest.dependency !== fixed.dependency) manifestError('dependency changed');
  if (fixed.closure && manifest.closure !== fixed.closure) manifestError('closure changed');
  if (manifest.issueNumber === 1188) {
    if (typeof manifest.issueBody !== 'string' || manifest.issueBody.length === 0) manifestError('Issue-1188 correction body is required');
    if (manifest.issueBodySha256 !== sha256(Buffer.from(manifest.issueBody, 'utf8'))) manifestError('Issue-1188 correction body digest mismatch');
  }
  return manifest as ParkedMigrationManifest;
}

export function buildParkedMigrationImport(manifestInput: ParkedMigrationManifest): ParkedMigrationImport {
  const manifest = validateParkedMigrationManifest(manifestInput);
  const bindingDigest = sha256(canonicalJson(manifest));
  const eventKey = sha256(canonicalJson({
    schema: 'create-issue-publication-event/v1',
    recordKind: 'migration',
    issueNumber: manifest.issueNumber,
    sourceRevision: manifest.sourceRevision,
    bindingDigest,
  }));
  const recordKey = sha256(canonicalJson({
    schema: 'create-issue-publication-record/v1',
    eventKey,
    recordKind: 'migration',
    slotOrRecordKind: 'migration',
    partIndex: 1,
    partCount: 1,
  }));
  const marker: ParsedRecordMarker = {
    schema: 'create-issue-review-record/v1',
    recordKind: 'migration',
    eventKey,
    recordKey,
    slotOrRecordKind: 'migration',
    partIndex: 1,
    partCount: 1,
  };
  const payload = { ...manifest, eventKey, recordKey };
  const body = `${buildRecordMarker(marker)}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  return { ...manifest, eventKey, recordKey, body };
}

export function loadParkedMigrationManifest(path: string): ParkedMigrationManifest {
  return validateParkedMigrationManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function publishParkedMigration(
  transport: GhTransport,
  repo: string,
  manifestInput: ParkedMigrationManifest,
): CommentPublicationResult & { import: ParkedMigrationImport } {
  const migration = buildParkedMigrationImport(manifestInput);
  const snapshot = createCommentCensus(transport, repo, migration.issueNumber);
  if (!snapshot.complete) return { state: 'pending-observation', reason: 'census-incomplete', import: migration } as CommentPublicationResult & { import: ParkedMigrationImport };
  if (snapshot.comments.some((comment) => comment.body === migration.body)) {
    return { state: 'published', reason: 'already-published', import: migration };
  }
  return { ...publishAfterCensus(transport, repo, migration.issueNumber, snapshot, migration.body), import: migration };
}

export function migrationInputIssue(issueNumber: number): ParkedMigrationIssue {
  if (!PARKED_MIGRATION_ISSUES.includes(issueNumber as ParkedMigrationIssue)) manifestError('caller-selected issue is not allowlisted');
  return issueNumber as ParkedMigrationIssue;
}

export function validateAllParkedMigrationManifests(
  manifests: readonly ParkedMigrationManifest[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const manifest of manifests) {
    try {
      const validated = validateParkedMigrationManifest(manifest);
      if (seen.has(validated.issueNumber)) errors.push(`duplicate migration ${validated.issueNumber}`);
      seen.add(validated.issueNumber);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const issue of PARKED_MIGRATION_ISSUES) if (!seen.has(issue)) errors.push(`missing migration ${issue}`);
  return { ok: errors.length === 0, errors };
}

export function allParkedMigrationsConfirmed(
  results: readonly (CommentPublicationResult & { import: ParkedMigrationImport })[],
): boolean {
  const confirmed = new Set(
    results.filter((result) => result.state === 'published').map((result) => result.import.issueNumber),
  );
  return PARKED_MIGRATION_ISSUES.every((issue) => confirmed.has(issue));
}

