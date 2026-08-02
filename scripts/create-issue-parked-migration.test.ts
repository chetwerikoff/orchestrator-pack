import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildParkedMigrationImport,
  loadParkedMigrationManifest,
  migrationInputIssue,
  validateParkedMigrationManifest,
} from './create-issue-parked-migration.ts';

describe('fixed parked review migrations', () => {
  it('accepts only the three byte-bound manifests', () => {
    for (const issue of [1168, 1173, 1188]) {
      const manifest = loadParkedMigrationManifest(`scripts/fixtures/create-issue-parked-migration-${issue}.json`);
      expect(manifest.issueNumber).toBe(issue);
      expect(buildParkedMigrationImport(manifest).body).toContain('create-issue-review-record/v1');
    }
    expect(() => migrationInputIssue(1199)).toThrow(/allowlisted/);
  });

  it('rejects an altered pinned byte or comment set', () => {
    const original = JSON.parse(readFileSync('scripts/fixtures/create-issue-parked-migration-1168.json', 'utf8')) as Record<string, unknown>;
    const comments = structuredClone(original.pinnedComments) as Array<Record<string, unknown>>;
    comments[0]!.body = `${comments[0]!.body} altered`;
    expect(() => validateParkedMigrationManifest({ ...original, pinnedComments: comments })).toThrow(/digest mismatch/);
    expect(() => validateParkedMigrationManifest({ ...original, pinnedComments: comments.slice(1) })).toThrow(/fixed comment set/);
  });
});

