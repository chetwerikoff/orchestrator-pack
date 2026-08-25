// @vitest-ci-lane light
// @vitest-pre-topology-seconds 120
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAuthoritativeTier, startPackReview } from './pack-review-runner.ts';

const roots: string[] = [];
const originalEnv = { ...process.env };
const HEAD = 'a'.repeat(40);

function setupHarness(storeRoot: string): void {
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'codex';
  process.env.OPK_BASE_DIR = join(storeRoot, 'base');
  process.env.OPK_REVIEW_CLAIM_DIR = join(storeRoot, 'base', 'projects', 'orchestrator-pack', 'review-start-claims');
  process.env.OPK_BOUND_ISSUE_SNAPSHOT_STORE_DIR = join(storeRoot, 'bound-issue-snapshots');
}

function cleanPayload(): string {
  return JSON.stringify({ verdict: 'clean', findingCount: 0, findings: [] });
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Issue #1647 authoritative tier resolution', () => {
  it('uses the canonical default for a legal Issue without a complexity-tier fence', () => {
    expect(parseAuthoritativeTier('# Firefighter repair\n\nNo tier is required.')).toBe('T2');
  });

  it('uses the canonical default for an explicit no-tier Issue', () => {
    expect(parseAuthoritativeTier('```complexity-tier\nskip-line: true\n```')).toBe('T2');
  });

  it('continues to reject an invalid complexity-tier fence', () => {
    expect(() => parseAuthoritativeTier('```complexity-tier\ntier: T4\n```'))
      .toThrow('authoritative Issue tier is invalid');
  });

  it('allows pack-review to produce a verdict for a firefighter Issue without a tier fence', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'pack-review-1647-tierless-'));
    roots.push(parent);
    const storeRoot = join(parent, 'store');
    setupHarness(storeRoot);

    const result = await startPackReview({
      projectId: 'orchestrator-pack',
      storeRoot,
      sourceRepoRoot: process.cwd(),
      prNumber: 1647,
      headSha: HEAD,
      fixtureCurrentPrHeadSha: HEAD,
      fixturePrState: 'OPEN',
      fixturePrBody: 'Closes #1647',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixturePostReviewHeadSha: HEAD,
      fixturePostReviewPrBody: 'Closes #1647',
      fixtureIssueBody: '# Firefighter repair\n\nNo complexity tier is required.',
      fixtureReviewStdout: cleanPayload(),
      fixtureGithubReviewId: 1647,
      fixtureRequiredStatusWriter: async () => {},
      fixtureWorkerNotifier: async () => ({ state: 'delivered' as const, reason: 'fixture' }),
    });

    expect(result).toMatchObject({ ok: true, created: true, reused: false });
  });
});
