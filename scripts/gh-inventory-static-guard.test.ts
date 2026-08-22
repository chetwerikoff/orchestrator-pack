// @vitest-ci-lane light
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { classifyArgv, isUnsupportedHighLevelRead } from './lib/gh-inventory-match.mjs';
import {
  isInventoryCoveredCommand,
  scanFileForViolations,
} from './lib/gh-inventory-static-guard.mjs';
describe('waiver runbook GitHub read inventory (Issue #1506)', () => {
  it('classifies every prescribed waiver read shape through a REST route', () => {
    const forms = [
      ['pr', 'view', '42', '--json', 'number,title,state,isDraft,mergeable,mergeStateStatus,headRefOid,body'],
      ['pr', 'checks', '42', '--json', 'name,state,bucket,description'],
      ['pr', 'view', '42', '--json', 'headRefOid', '-q', '.headRefOid'],
      ['pr', 'view', '42', '--json', 'state,mergedAt,mergeCommit'],
    ];

    for (const argv of forms) {
      expect(classifyArgv(argv).route?.id).toMatch(/^pr-(view|checks)$/);
    }
  });

  it('routes supported field projections and fails closed for unsupported fields', () => {
    expect(isInventoryCoveredCommand('gh pr view 42 --json state,mergeable')).toBe(true);
    expect(isInventoryCoveredCommand('gh pr checks 42 --json name,description')).toBe(true);
    const unsupported = classifyArgv(['pr', 'view', '42', '--json', 'commits']);
    expect(unsupported.route).toBeNull();
    expect(isUnsupportedHighLevelRead(unsupported.parsed)).toBe(true);
  });

  it('maps REST merge fields to gh view output names', async () => {
    const { mapPullForFields } = await import('./lib/gh-rest-routes.mjs');
    expect(mapPullForFields({
      number: 919,
      mergeable: true,
      mergeable_state: 'clean',
      merge_commit_sha: 'abc123',
    }, ['number', 'mergeable', 'mergeStateStatus', 'mergeCommit'])).toEqual({
      number: 919,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      mergeCommit: { oid: 'abc123' },
    });
  });

  it('covers the tracked waiver runbook itself', () => {
    const file = join(process.cwd(), 'docs/pack-review-waiver-merge-runbook.md');
    expect(scanFileForViolations(file, 'rules')).toEqual([]);
  });

  it('rejects an uncovered executable high-level read fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-guard-waiver-'));
    const file = join(dir, 'fixture.md');
    try {
      writeFileSync(file, 'Run `gh pr view 42 --json commits` before merging.\n', 'utf8');
      const violations = scanFileForViolations(file, 'rules');
      expect(violations.some((item) => item.command.includes('commits'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
