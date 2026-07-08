#!/usr/bin/env node
/**
 * Fixture suite for runtime-history refresh guards (Issue #691).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLanePlan } from './vitest-ci-lanes.mjs';
import { defaultRepoRoot, classifyHeavyFiles } from './vitest-runtime-history-merge.mjs';
import {
  SMOOTHING_RULE,
  MEASURED_SOURCE,
  SEEDED_SOURCE,
  buildSyntheticVitestReport,
  historyBytes,
  medianMs,
  mergeConcurrentRefreshes,
  mergeValidatedDurations,
  normalizeHistory,
  refreshRuntimeHistory,
  stableStringify,
} from './vitest-runtime-history-merge.mjs';

const failures = [];

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function writeReport(dir, shard, files, commitSha) {
  const reportPath = join(dir, `shard-${shard}.json`);
  const metaPath = join(dir, `shard-${shard}.meta.json`);
  writeFileSync(reportPath, stableStringify(buildSyntheticVitestReport(files)), 'utf8');
  writeFileSync(
    metaPath,
    stableStringify({
      commitSha,
      shard,
      success: true,
      runId: 'fixture-run',
    }),
    'utf8',
  );
  return reportPath;
}

function seededHistory() {
  return normalizeHistory({
    issue: 556,
    source: SEEDED_SOURCE,
    dataChangedAt: null,
    smoothingRule: SMOOTHING_RULE,
    files: {
      'scripts/check-ci-pipeline-split.test.ts': 45000,
      'scripts/orchestrator-wake-supervisor.test.ts': 180000,
    },
    provenance: {
      'scripts/check-ci-pipeline-split.test.ts': 'seeded',
      'scripts/orchestrator-wake-supervisor.test.ts': 'seeded',
    },
    recentSamples: {},
  });
}

function buildCompleteShardSet(dir, commitSha, fileAssignments) {
  const shardReports = new Map();
  for (const [shard, files] of fileAssignments.entries()) {
    writeReport(dir, shard, files, commitSha);
    shardReports.set(shard, {
      reportPath: join(dir, `shard-${shard}.json`),
      meta: { commitSha, shard, success: true },
    });
  }
  return shardReports;
}

function buildLanePlanShardReports(dir, commitSha, repoRoot, durationForFile = () => 12000) {
  const plan = buildLanePlan(repoRoot);
  if (!plan.ok) {
    throw new Error(plan.errors.join('; '));
  }
  const assignments = new Map();
  for (const shardPlan of plan.heavyShards) {
    assignments.set(
      shardPlan.shard,
      shardPlan.files.map((file) => ({
        file,
        durationMs:
          typeof durationForFile === 'function' ? durationForFile(file) : durationForFile,
      })),
    );
  }
  return buildCompleteShardSet(dir, commitSha, assignments);
}

function runMeasuredRefreshFixture() {
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-measured`);
  mkdirSync(dir, { recursive: true });
  const commitSha = 'deadbeef';
  const targetFile = 'scripts/check-ci-pipeline-split.test.ts';
  const shardReports = buildLanePlanShardReports(
    dir,
    commitSha,
    defaultRepoRoot,
    (file) => (file === targetFile ? 22000 : 12000),
  );
  const base = seededHistory();
  const result = refreshRuntimeHistory({
    baseHistory: base,
    shardReports,
    expectedCommitSha: commitSha,
    repoRoot: defaultRepoRoot,
  });

  assert(result.ok, 'measured refresh should accept complete shard set');
  assert(result.history.source === MEASURED_SOURCE, 'source must switch to ci-measured');
  assert(
    result.history.files[targetFile] !== 45000,
    'measured file must move off seeded 45000 placeholder',
  );
  assert(
    result.history.provenance[targetFile] === 'measured',
    'provenance must be measured for refreshed file',
  );
  rmSync(dir, { recursive: true, force: true });
}

function runSmoothingFixture() {
  const base = seededHistory();
  const file = 'scripts/check-ci-pipeline-split.test.ts';
  base.recentSamples[file] = [10000, 10200];
  const merged = mergeValidatedDurations(
    base,
    new Map([[file, 500000]]),
    [file],
  );
  const smoothed = merged.history.files[file];
  assert(smoothed !== 500000, 'spike must not become recorded weight');
  assert(smoothed === medianMs([10000, 10200, 500000]), 'recorded weight must follow median smoothing rule');
}

function runCorruptInputFixtures() {
  const base = seededHistory();
  const baseBytes = historyBytes(base);
  const commitSha = 'deadbeef';
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-corrupt`);
  mkdirSync(dir, { recursive: true });

  const cases = [
    {
      name: 'missing report',
      build() {
        const shardReports = new Map();
        for (let shard = 1; shard <= 7; shard += 1) {
          if (shard === 3) {
            shardReports.set(shard, { reportPath: join(dir, 'missing.json') });
            continue;
          }
          writeReport(dir, shard, [], commitSha);
          shardReports.set(shard, {
            reportPath: join(dir, `shard-${shard}.json`),
            meta: { commitSha, shard, success: true },
          });
        }
        return shardReports;
      },
    },
    {
      name: 'truncated json',
      build() {
        const shardReports = buildLanePlanShardReports(dir, commitSha, defaultRepoRoot);
        writeFileSync(join(dir, 'shard-2.json'), '{not-json', 'utf8');
        return shardReports;
      },
    },
    {
      name: 'zero-file report',
      build() {
        const shardReports = buildLanePlanShardReports(dir, commitSha, defaultRepoRoot);
        writeFileSync(join(dir, 'shard-4.json'), stableStringify({ testResults: [] }), 'utf8');
        return shardReports;
      },
    },
  ];

  for (const testCase of cases) {
    const shardReports = testCase.build();
    const result = refreshRuntimeHistory({
      baseHistory: base,
      shardReports,
      expectedCommitSha: commitSha,
      repoRoot: defaultRepoRoot,
    });
    assert(
      historyBytes(result.history) === baseBytes,
      `${testCase.name}: history must remain byte-unchanged`,
    );
  }

  rmSync(dir, { recursive: true, force: true });
}

function runRaceSafeFixture() {
  const base = seededHistory();
  const fileA = 'scripts/check-ci-pipeline-split.test.ts';
  const fileB = 'scripts/orchestrator-wake-supervisor.test.ts';

  const updateOne = normalizeHistory(base);
  updateOne.files[fileA] = 21000;
  updateOne.provenance[fileA] = 'measured';
  updateOne.recentSamples[fileA] = [21000];
  updateOne.fileChangedAt = { [fileA]: '2026-07-01T10:00:00.000Z' };
  updateOne.source = MEASURED_SOURCE;
  updateOne.dataChangedAt = '2026-07-01T10:00:00.000Z';

  const updateTwo = normalizeHistory(base);
  updateTwo.files[fileB] = 95000;
  updateTwo.provenance[fileB] = 'measured';
  updateTwo.recentSamples[fileB] = [95000];
  updateTwo.fileChangedAt = { [fileB]: '2026-07-01T11:00:00.000Z' };
  updateTwo.source = MEASURED_SOURCE;
  updateTwo.dataChangedAt = '2026-07-01T11:00:00.000Z';

  const merged = mergeConcurrentRefreshes(base, [updateOne, updateTwo]);
  assert(merged.files[fileA] === 21000, 'concurrent merge must retain measurement A');
  assert(merged.files[fileB] === 95000, 'concurrent merge must retain measurement B');
  assert(
    merged.dataChangedAt === '2026-07-01T11:00:00.000Z',
    'concurrent merge must keep newest dataChangedAt',
  );

  const newer = normalizeHistory(base);
  newer.files[fileA] = 21000;
  newer.provenance[fileA] = 'measured';
  newer.fileChangedAt = { [fileA]: '2026-07-01T10:00:00.000Z' };
  newer.dataChangedAt = '2026-07-01T10:00:00.000Z';
  const stale = normalizeHistory(base);
  stale.files[fileA] = 10000;
  stale.fileChangedAt = { [fileA]: '2026-06-01T00:00:00.000Z' };
  const mergedForward = mergeConcurrentRefreshes(newer, [stale]);
  assert(mergedForward.files[fileA] === 21000, 'stale-base refresh must not regress newer snapshot');

  const idempotent = refreshRuntimeHistory({
    baseHistory: updateTwo,
    shardReports: new Map(),
    expectedCommitSha: 'missing',
    repoRoot: defaultRepoRoot,
  });
  assert(idempotent.rejected, 'empty shard set must reject without corrupting');
}

function runProvenanceGateFixtures() {
  const base = seededHistory();
  const baseBytes = historyBytes(base);
  const commitSha = 'deadbeef';
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-prov`);
  mkdirSync(dir, { recursive: true });
  const heavy = classifyHeavyFiles(defaultRepoRoot).heavy;

  const partialAssignments = new Map();
  for (let shard = 1; shard <= 6; shard += 1) {
    partialAssignments.set(shard, [{ file: heavy[shard - 1], durationMs: 12000 }]);
  }
  const partial = refreshRuntimeHistory({
    baseHistory: base,
    shardReports: buildCompleteShardSet(dir, commitSha, partialAssignments),
    expectedCommitSha: commitSha,
    repoRoot: defaultRepoRoot,
  });
  assert(partial.rejected, 'partial shard set must be rejected');
  assert(historyBytes(partial.history) === baseBytes, 'partial shard set must not mutate history');

  const mismatchReports = buildLanePlanShardReports(dir, commitSha, defaultRepoRoot);
  mismatchReports.get(2).meta = { commitSha: 'badsha', shard: 2, success: true };
  const mismatch = refreshRuntimeHistory({
    baseHistory: base,
    shardReports: mismatchReports,
    expectedCommitSha: commitSha,
    repoRoot: defaultRepoRoot,
  });
  assert(mismatch.rejected, 'commit mismatch must be rejected');

  const unknownReports = buildLanePlanShardReports(dir, commitSha, defaultRepoRoot);
  const unknownShard1 = unknownReports.get(1);
  writeFileSync(
    unknownShard1.reportPath,
    stableStringify(
      buildSyntheticVitestReport([
        { file: 'scripts/__classification_required_fixture__.test.ts', durationMs: 12000 },
      ]),
    ),
    'utf8',
  );
  const unknown = refreshRuntimeHistory({
    baseHistory: base,
    shardReports: unknownReports,
    expectedCommitSha: commitSha,
    repoRoot: defaultRepoRoot,
  });
  assert(unknown.rejected, 'unclassified path must be rejected');

  const partialTimingAssignments = new Map();
  for (let shard = 1; shard <= 7; shard += 1) {
    partialTimingAssignments.set(shard, [{ file: heavy[shard - 1], durationMs: 12000 }]);
  }
  const uncoveredHeavy = 'scripts/orchestrator-wake-supervisor.test.ts';
  const partialTiming = refreshRuntimeHistory({
    baseHistory: base,
    shardReports: buildCompleteShardSet(dir, commitSha, partialTimingAssignments),
    expectedCommitSha: commitSha,
    repoRoot: defaultRepoRoot,
  });
  assert(
    partialTiming.ok && !partialTiming.rejected,
    'valid partial per-file timing gaps must accept merge',
  );
  assert(
    partialTiming.history.provenance[heavy[0]] === 'measured',
    'covered heavy file must be measured after partial timing refresh',
  );
  assert(
    partialTiming.history.files[uncoveredHeavy] === base.files[uncoveredHeavy],
    'uncovered heavy file must retain prior recorded weight',
  );
  assert(
    partialTiming.history.provenance[uncoveredHeavy] === 'seeded',
    'uncovered heavy file must retain prior provenance',
  );

  rmSync(dir, { recursive: true, force: true });
}

function runCoverageAndDurableProvenanceFixture() {
  const base = seededHistory();
  const measuredFile = 'scripts/check-ci-pipeline-split.test.ts';
  base.provenance[measuredFile] = 'measured';
  base.recentSamples[measuredFile] = [18000];
  base.files[measuredFile] = 18000;
  base.source = MEASURED_SOURCE;
  base.dataChangedAt = '2026-07-01T00:00:00.000Z';

  const partial = mergeValidatedDurations(base, new Map(), classifyHeavyFiles(defaultRepoRoot).heavy);
  assert(
    partial.history.provenance[measuredFile] === 'measured',
    'earlier measured provenance must survive partial valid run',
  );
  assert(
    partial.history.provenance['scripts/orchestrator-wake-supervisor.test.ts'] === 'seeded',
    'never-measured seed must stay seeded',
  );

  const shortfall = partial.coverage;
  assert(shortfall.shortfall, 'mostly seeded heavy set must surface measured-coverage shortfall');
}

export function runRuntimeHistoryRefreshFixtures() {
  failures.length = 0;
  runMeasuredRefreshFixture();
  runSmoothingFixture();
  runCorruptInputFixtures();
  runRaceSafeFixture();
  runProvenanceGateFixtures();
  runCoverageAndDurableProvenanceFixture();
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runRuntimeHistoryRefreshFixtures();
  if (result.length > 0) {
    console.error('[FAIL] runtime-history refresh fixtures:');
    for (const line of result) {
      console.error(` - ${line}`);
    }
    process.exit(1);
  }
  console.log('[PASS] runtime-history refresh fixtures OK');
}
