// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalReviewStateRoot, resolveCanonicalReviewDirectory } from './canonical-review-directory.ts';

const selected = vi.hoisted(() => ({ repository: 'owner/alpha' }));
vi.mock('./target-context.ts', () => ({
  resolveTargetContext: ({ projectId }: { projectId: string }) => ({ projectId, repository: selected.repository }),
}));

const originalEnv = {
  HOME: process.env.HOME,
  OPK_PROJECT_ID: process.env.OPK_PROJECT_ID,
  OPK_CREATE_ISSUE_DRAFT_STATE_ROOT: process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT,
};
const roots: string[] = [];
afterEach(() => {
  selected.repository = 'owner/alpha';
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #2186 canonical review project authority', () => {
  it('rejects unqualified production resolution and a flat environment override', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'opk-2186-review-'));
    roots.push(home);
    process.env.HOME = home;
    delete process.env.OPK_PROJECT_ID;
    delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    const fixtureFlag = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => canonicalReviewStateRoot()).toThrow('create_issue_project_selection_required');
      expect(() => resolveCanonicalReviewDirectory({ taskIdentity: 'issue:7' }))
        .toThrow('create_issue_project_selection_required');
      process.env.OPK_PROJECT_ID = 'alpha';
      process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = path.join(home, '.local', 'state', 'create-issue-draft');
      expect(() => canonicalReviewStateRoot()).toThrow('create_issue_state_root_override_untrusted');
    } finally {
      if (fixtureFlag !== undefined) process.env.VITEST = fixtureFlag;
    }
  });

  it('retains the current repository binding and rejects project-card retarget', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'opk-2186-review-'));
    roots.push(home);
    process.env.HOME = home;
    process.env.OPK_PROJECT_ID = 'alpha';
    delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    const canonical = resolveCanonicalReviewDirectory({ taskIdentity: 'issue:7' });
    expect(canonical.directory).toBe(path.join(home, '.local', 'state', 'create-issue-draft', 'alpha', '.review', '7'));
    selected.repository = 'owner/other';
    expect(() => resolveCanonicalReviewDirectory({ taskIdentity: 'issue:7' }))
      .toThrow('project_state_binding_mismatch');
  });
});
