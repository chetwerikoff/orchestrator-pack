// @vitest-ci-lane light
// @vitest-pre-topology-seconds 60
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACK_REVIEW_LOGICAL_CAPS,
  PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
  createNewPackReviewCycle,
  selectPackReviewGptSourceCardinality,
} from '../pack-review-state.ts';
import {
  createPackReviewRun,
  getPackReviewRun,
  listPackReviewRuns,
  type PackReviewGptRoundRecord,
  type PackReviewRunRecord,
} from './pack-review-run-store.ts';

const HEAD = 'a'.repeat(40);
const repository = 'chetwerikoff/orchestrator-pack';
const projectId = 'orchestrator-pack';
const roots: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(): { storeRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'opk-2777-historical-cap-'));
  roots.push(root);
  const storeRoot = join(root, 'store');
  process.env.OPK_VITEST_HARNESS = '1';
  process.env.PACK_REVIEWER = 'gpt';
  process.env.PACK_REVIEW_BOUND_REVIEWER = 'gpt';
  process.env.XDG_CONFIG_HOME = join(storeRoot, 'test-config');
  const projects = join(process.env.XDG_CONFIG_HOME, 'orchestrator-pack', 'projects');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${projectId}.json`), JSON.stringify({
    projectId, repository, primaryRoot: process.cwd(), defaultBranch: 'main',
    orcaWorkspacePattern: '^test-only$', orchestratorTitlePattern: '^test-only$',
    browserGpt: { projectUrl: 'https://example.invalid/test-only' },
  }));
  process.env.OPK_BASE_DIR = join(storeRoot, 'base');
  return { storeRoot };
}

function t3Round(roundOrdinal: number): PackReviewGptRoundRecord {
  return {
    schema: 'pack-review-gpt-round/v1', reviewer: 'gpt', tier: 'T3',
    accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
    roundOrdinal, cardinality: 3, issueNumber: 2777,
    boundIssueSnapshotDigest: 'd'.repeat(64),
    sourceSlots: [1, 2, 3].map((ordinal) => ({
      slotId: `source-0${ordinal}`, ordinal, lifecycle: 'planned' as const,
    })),
  };
}

function createT3Run(
  storeRoot: string,
  input: { logicalRoundOrdinal: number; logicalRoundCap?: number; roundOrdinal?: number },
): PackReviewRunRecord {
  return createPackReviewRun({
    projectId, storeRoot, prNumber: 515, headSha: HEAD,
    trustedPackRoot: process.cwd(), sourceRepoRoot: process.cwd(),
    canonicalRepository: repository,
    accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
    reviewCycleId: 'cycle-2777',
    logicalRoundOrdinal: input.logicalRoundOrdinal,
    ...(input.logicalRoundCap === undefined ? {} : { logicalRoundCap: input.logicalRoundCap }),
    automaticBudgetDisposition: 'consume',
    resolvedReviewer: 'gpt',
    reviewRound: t3Round(input.roundOrdinal ?? input.logicalRoundOrdinal),
  }).run;
}

describe('Issue #2777 historical logical round cap on read', () => {
  it('loads a saved T3 record whose cap (1) differs from today\'s T3 cap', () => {
    expect(PACK_REVIEW_LOGICAL_CAPS.T3).not.toBe(1);
    const { storeRoot } = harness();
    const options = { projectId, storeRoot };
    // Realistic historical file: written when the cap was 1, then re-read today.
    const created = createT3Run(storeRoot, { logicalRoundOrdinal: 1, logicalRoundCap: PACK_REVIEW_LOGICAL_CAPS.T3 });
    const path = join(storeRoot, 'runs', `${created.id}.json`);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as PackReviewRunRecord;
    saved.logicalRoundCap = 1;
    saved.accountingVersion = 'issue-1826-logical-rounds-1-1-2';
    writeFileSync(path, JSON.stringify(saved));

    expect(getPackReviewRun(created.id, options)).toMatchObject({
      id: created.id, logicalRoundCap: 1, logicalRoundOrdinal: 1,
      accountingVersion: 'issue-1826-logical-rounds-1-1-2',
    });
    // The project-store scan is not aborted by the historical row.
    expect(listPackReviewRuns(options).map((run) => run.id)).toEqual([created.id]);
  });

  it('still enforces current caps at new-round admission', () => {
    const { storeRoot } = harness();
    const overCap = PACK_REVIEW_LOGICAL_CAPS.T3 + 1;
    expect(() => createT3Run(storeRoot, {
      logicalRoundOrdinal: overCap, logicalRoundCap: PACK_REVIEW_LOGICAL_CAPS.T3,
    })).toThrow();
    expect(() => selectPackReviewGptSourceCardinality({
      reviewer: 'gpt', tier: 'T3', roundOrdinal: overCap,
      accountingVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION,
    })).toThrow(/exceeds logical tier cap/);
    expect(createNewPackReviewCycle('T3', { capMapVersion: PACK_REVIEW_LOGICAL_CAP_MAP_VERSION }).frozenCap)
      .toBe(PACK_REVIEW_LOGICAL_CAPS.T3);
    expect(listPackReviewRuns({ projectId, storeRoot })).toEqual([]);
  });

  it('keeps the other logical identity checks', () => {
    const { storeRoot } = harness();
    expect(() => createT3Run(storeRoot, { logicalRoundOrdinal: 1 }))
      .toThrow(/GPT logical source version\/round identity mismatch/);
    expect(() => createT3Run(storeRoot, { logicalRoundOrdinal: 2, logicalRoundCap: 2, roundOrdinal: 1 }))
      .toThrow(/GPT logical source version\/round identity mismatch/);
    expect(() => createT3Run(storeRoot, { logicalRoundOrdinal: 2, logicalRoundCap: 1, roundOrdinal: 2 }))
      .toThrow(/logicalRoundOrdinal exceeds logicalRoundCap/);
  });
});
