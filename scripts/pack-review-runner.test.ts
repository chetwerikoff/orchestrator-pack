import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listPackReviewRuns, resolvePackReviewRunStoreRoot } from './lib/pack-review-run-store.js';
import { startPackReview } from './pack-review-runner.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalEnv = { ...process.env };
const tempRoots: string[] = [];
const HEAD_SHA = 'c'.repeat(40);

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack review runner delivery identity (Issue #862)', () => {
  it('overrides stale inherited identity and records delivery before GitHub posting', async () => {
    const projectId = 'another-project';
    const storeRoot = tempRoot('opk-review-explicit-store-');
    const inheritedStoreRoot = tempRoot('opk-review-stale-store-');
    const wrapperPath = path.join(tempRoot('opk-review-wrapper-'), 'fixture-reviewer.ps1');
    const childEnvCapture = path.join(tempRoot('opk-review-env-'), 'child-env.json');
    const githubCapture = path.join(tempRoot('opk-review-github-'), 'review.json');
    const resolvedStoreRoot = resolvePackReviewRunStoreRoot({ projectId, storeRoot });

    writeFileSync(wrapperPath, String.raw`param()
$ErrorActionPreference = 'Stop'
$payload = [ordered]@{
    projectId = [string]$env:PACK_REVIEW_PROJECT_ID
    storeRoot = [string]$env:PACK_REVIEW_RUN_STORE_ROOT
}
[System.IO.File]::WriteAllText(
    [string]$env:OPK_VITEST_PACK_REVIEW_ENV_CAPTURE,
    ($payload | ConvertTo-Json -Compress),
    [System.Text.UTF8Encoding]::new($false)
)
[Console]::Out.WriteLine('{"verdict":"clean","findingCount":0,"findings":[]}')
exit 0
`, 'utf8');

    process.env.OPK_VITEST_HARNESS = '1';
    process.env.PACK_REVIEWER = 'codex';
    process.env.PACK_REVIEW_PROJECT_ID = 'stale-project';
    process.env.PACK_REVIEW_RUN_STORE_ROOT = inheritedStoreRoot;
    process.env.AO_SCRIPTED_REVIEW_SKIP_POST_SUBMIT_DELIVERY = '1';
    process.env.OPK_VITEST_PACK_REVIEW_ENV_CAPTURE = childEnvCapture;
    process.env.PACK_REVIEW_GITHUB_REVIEW_CAPTURE_FILE = githubCapture;

    const result = await startPackReview({
      projectId,
      storeRoot,
      sourceRepoRoot: repoRoot,
      prNumber: 862,
      headSha: HEAD_SHA,
      claimMode: 'preacquired',
      fixtureRepoSlug: 'chetwerikoff/orchestrator-pack',
      fixtureGithubReviewId: 86201,
      fixtureReviewWrapperPath: wrapperPath,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'up_to_date',
      githubReviewId: 86201,
    });
    expect(JSON.parse(readFileSync(childEnvCapture, 'utf8'))).toEqual({
      projectId,
      storeRoot: resolvedStoreRoot,
    });
    expect(JSON.parse(readFileSync(githubCapture, 'utf8'))).toMatchObject({
      prNumber: 862,
      commitId: HEAD_SHA,
      event: 'APPROVE',
    });

    const runs = listPackReviewRuns({ projectId, storeRoot });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      projectId,
      status: 'up_to_date',
      exitCode: 0,
      githubReviewId: 86201,
      deliveryOutcome: {
        classification: 'skipped',
        escalated: false,
        reason: 'env_skip',
      },
    });
    expect(listPackReviewRuns({ projectId: 'stale-project', storeRoot: inheritedStoreRoot })).toEqual([]);

    const entrypoint = readFileSync(path.join(repoRoot, 'scripts/invoke-pack-review.ps1'), 'utf8');
    expect(entrypoint.match(/-ProjectId \$projectId/g)).toHaveLength(2);
  });
});
