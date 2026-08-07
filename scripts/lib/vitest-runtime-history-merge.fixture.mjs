#!/usr/bin/env node
/**
 * Fixture suite for runtime-history refresh guards (Issue #691 / #1384).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runProcessSync } from '../kernel/subprocess.ts';
import { buildLanePlan, discoverVitestFiles } from './vitest-ci-lanes.mjs';
import {
  buildHeavyTopology,
  findOversizedFiles,
} from './vitest-heavy-topology.mjs';
import {
  PRE_TOPOLOGY_MAX_FILES,
  resolvePreTopologyMeasurementPlan,
} from './vitest-pre-topology-measurement.mjs';
import {
  defaultRepoRoot,
  classifyHeavyFiles,
  SMOOTHING_RULE,
  MEASURED_SOURCE,
  SEEDED_SOURCE,
  SUPPLEMENTAL_META_SCHEMA,
  SUPPLEMENTAL_TARGET,
  buildSyntheticVitestReport,
  diffRuntimeHistoryInventories,
  historyBytes,
  medianMs,
  mergeConcurrentRefreshes,
  reconcileProposedHistoryAgainstRemote,
  reconcileTrustedInventory,
  mergeValidatedDurations,
  normalizeHistory,
  refreshRuntimeHistory,
  runtimeHistoryInventory,
  stableStringify,
} from './vitest-runtime-history-merge.mjs';

const failures = [];
const SUPPLEMENTAL_TUPLE_ERROR =
  'SupplementalReportsDir, SupplementalSourceSha, SupplementalRunId, and SupplementalRunAttempt must be supplied together';
const ISSUE_1384_STARTING_CENSUS_SHA256 = 'a6ea3c28c365898a52a8aa8a0c06f97b7158c94184054daef2f61bc5c5dfa36a';
const PR_1376_REPLAY_BASE_SHA = '6e9614d0c9ce0c34b41a731059df4398b770c162';
const PR_1376_REPLAY_HEAD_SHA = 'de03343f3f71f0c673157e055bf47f62700a576b';
const PR_1376_CHANGED_FILES = [
  '.cursor/rules/flow-manager-browser-turn-monitoring.mdc',
  'docs/declarations/1266.pr-scope.json',
  'package.json',
  'scripts/browser-gpt-post-settlement-close-proof.ts',
  'scripts/browser-gpt-post-settlement-close.ts',
  'scripts/chatgpt-browser-turn/browser-session.ts',
  'scripts/chatgpt-browser-turn/contracts.ts',
  'scripts/chatgpt-browser-turn/tab-lifecycle.test.ts',
].sort();

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function assertThrows(fn, needle, message) {
  try {
    fn();
    fail(`${message}: expected throw`);
  } catch (error) {
    if (!String(error?.message ?? error).includes(needle)) {
      fail(`${message}: unexpected error ${String(error?.message ?? error)}`);
    }
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

function writeCanonicalSupplementalReport(dir, sourceSha, durationMs = 321) {
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, 'supplemental-pack-reviewer-preference.json');
  const metaPath = `${reportPath}.meta.json`;
  const report = {
    success: true,
    numFailedTests: 0,
    ...buildSyntheticVitestReport(
      [{ file: SUPPLEMENTAL_TARGET, durationMs }],
      join(defaultRepoRoot, 'supplemental-source'),
    ),
  };
  writeFileSync(reportPath, stableStringify(report), 'utf8');
  writeFileSync(metaPath, stableStringify({
    schema: SUPPLEMENTAL_META_SCHEMA,
    repository: 'chetwerikoff/orchestrator-pack',
    target: SUPPLEMENTAL_TARGET,
    commitSha: sourceSha,
    success: true,
    conclusion: 'success',
    lane: 'light',
    discovery: {
      source: 'scripts/vitest-ci-lanes.config.json',
      target: SUPPLEMENTAL_TARGET,
      lane: 'light',
    },
    runId: '9001',
    runAttempt: '1',
  }), 'utf8');
}

function runMeasuredRefreshFixture() {
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-measured`);
  mkdirSync(dir, { recursive: true });
  const commitSha = 'deadbeef';
  const targetFile = classifyHeavyFiles(defaultRepoRoot).heavy[0];
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

function runIdenticalRerunIdempotentFixture() {
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-rerun`);
  mkdirSync(dir, { recursive: true });
  const commitSha = 'deadbeef';
  const shardReports = buildLanePlanShardReports(dir, commitSha, defaultRepoRoot);
  const base = seededHistory();
  const first = refreshRuntimeHistory({
    baseHistory: base,
    shardReports,
    expectedCommitSha: commitSha,
    repoRoot: defaultRepoRoot,
  });
  assert(first.ok, 'first refresh must accept complete shard set');
  assert(first.changed, 'first refresh must change history');
  const firstBytes = historyBytes(first.history);

  const second = refreshRuntimeHistory({
    baseHistory: first.history,
    shardReports,
    expectedCommitSha: commitSha,
    repoRoot: defaultRepoRoot,
  });
  assert(second.ok, 'identical rerun must accept the same shard set');
  assert(second.idempotent, 'identical rerun must be idempotent');
  assert(!second.changed, 'identical rerun must not report changed');
  assert(
    historyBytes(second.history) === firstBytes,
    'identical rerun must leave history byte-unchanged',
  );

  rmSync(dir, { recursive: true, force: true });
}

function runMeasuredSourceWithoutWeightChangeFixture() {
  const base = seededHistory();
  const file = 'scripts/check-ci-pipeline-split.test.ts';
  base.recentSamples[file] = [44000, 45000, 46000];
  const merged = mergeValidatedDurations(base, new Map([[file, 45000]]), [file]);
  assert(
    merged.history.source === MEASURED_SOURCE,
    'source must switch to measured when samples accepted without weight change',
  );
  assert(
    merged.history.files[file] === 45000,
    'weight unchanged when smoothed equals seeded placeholder',
  );
  assert(merged.history.provenance[file] === 'measured');
}

function runMetadataOnlyReconcileFixture() {
  const base = seededHistory();
  const file = 'scripts/check-ci-pipeline-split.test.ts';
  const remote = normalizeHistory(base);

  const proposed = normalizeHistory(base);
  proposed.recentSamples[file] = [44000, 45000, 46000];
  proposed.provenance[file] = 'measured';
  proposed.source = MEASURED_SOURCE;
  proposed.dataChangedAt = '2026-07-03T00:00:00.000Z';

  const merged = reconcileProposedHistoryAgainstRemote(proposed, remote);
  assert(
    merged.provenance[file] === 'measured',
    'metadata-only reconcile must preserve measured provenance',
  );
  assert(
    Array.isArray(merged.recentSamples[file]) && merged.recentSamples[file].length === 3,
    'metadata-only reconcile must preserve recentSamples',
  );
  assert(merged.files[file] === 45000, 'metadata-only reconcile must keep unchanged weight');
  assert(merged.source === MEASURED_SOURCE, 'metadata-only reconcile must keep measured source');
}

function runStaleBaseReconcileFixture() {
  const base = seededHistory();
  const remote = normalizeHistory(base);
  remote.files['scripts/orchestrator-wake-supervisor.test.ts'] = 99000;
  remote.provenance['scripts/orchestrator-wake-supervisor.test.ts'] = 'measured';
  remote.recentSamples['scripts/orchestrator-wake-supervisor.test.ts'] = [99000];
  remote.fileChangedAt = {
    'scripts/orchestrator-wake-supervisor.test.ts': '2026-07-02T00:00:00.000Z',
  };
  remote.source = MEASURED_SOURCE;
  remote.dataChangedAt = '2026-07-02T00:00:00.000Z';

  const proposed = normalizeHistory(base);
  proposed.files['scripts/check-ci-pipeline-split.test.ts'] = 21000;
  proposed.provenance['scripts/check-ci-pipeline-split.test.ts'] = 'measured';
  proposed.recentSamples['scripts/check-ci-pipeline-split.test.ts'] = [21000];
  proposed.fileChangedAt = {
    'scripts/check-ci-pipeline-split.test.ts': '2026-07-03T00:00:00.000Z',
  };
  proposed.source = MEASURED_SOURCE;
  proposed.dataChangedAt = '2026-07-03T00:00:00.000Z';

  const merged = reconcileProposedHistoryAgainstRemote(proposed, remote);
  assert(
    merged.files['scripts/check-ci-pipeline-split.test.ts'] === 21000,
    'stale-base reconcile must retain proposed measurement',
  );
  assert(
    merged.files['scripts/orchestrator-wake-supervisor.test.ts'] === 99000,
    'stale-base reconcile must retain newer remote measurement',
  );
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
  const { heavyShardCount } = classifyHeavyFiles(defaultRepoRoot);

  const cases = [
    {
      name: 'missing report',
      build() {
        const shardReports = new Map();
        for (let shard = 1; shard <= heavyShardCount; shard += 1) {
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
        writeFileSync(join(dir, 'shard-1.json'), '{not-json', 'utf8');
        return shardReports;
      },
    },
    {
      name: 'zero-file report',
      build() {
        const shardReports = buildLanePlanShardReports(dir, commitSha, defaultRepoRoot);
        writeFileSync(join(dir, 'shard-1.json'), stableStringify({ testResults: [] }), 'utf8');
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
  const { heavy, heavyShardCount } = classifyHeavyFiles(defaultRepoRoot);

  const partialAssignments = new Map();
  for (let shard = 1; shard < heavyShardCount; shard += 1) {
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
  const mismatchShard = [...mismatchReports.keys()][0];
  mismatchReports.get(mismatchShard).meta = { commitSha: 'badsha', shard: mismatchShard, success: true };
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
  for (let shard = 1; shard <= heavyShardCount; shard += 1) {
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

function writeSupplementalReport(dir, sourceSha, durationMs, overrides = {}) {
  const reportPath = join(dir, 'supplemental.json');
  const metaPath = join(dir, 'supplemental.meta.json');
  const target = overrides.target ?? SUPPLEMENTAL_TARGET;
  const report = {
    success: true,
    numFailedTests: 0,
    ...buildSyntheticVitestReport([{ file: target, durationMs }], join(defaultRepoRoot, 'supplemental-source')),
  };
  writeFileSync(reportPath, stableStringify(report), 'utf8');
  writeFileSync(
    metaPath,
    stableStringify({
      schema: SUPPLEMENTAL_META_SCHEMA,
      repository: 'chetwerikoff/orchestrator-pack',
      target,
      commitSha: sourceSha,
      success: true,
      conclusion: 'success',
      lane: 'light',
      discovery: {
        source: 'scripts/vitest-ci-lanes.config.json',
        target,
        lane: 'light',
      },
      runId: '9001',
      runAttempt: '1',
      ...overrides,
    }),
    'utf8',
  );
  return new Map([[SUPPLEMENTAL_TARGET, { reportPath, metaPath, meta: JSON.parse(readFileSync(metaPath, 'utf8')) }]]);
}

function runSupplementalTargetFixtures() {
  const base = seededHistory();
  const baseBytes = historyBytes(base);
  const heavyCommit = 'deadbeef';
  const sourceSha = 'aede47815ccadb54ac0ce405e8e359a343d196fe';
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-supplemental`);
  mkdirSync(dir, { recursive: true });
  const shardReports = buildLanePlanShardReports(dir, heavyCommit, defaultRepoRoot);
  const supplementalReports = writeSupplementalReport(dir, sourceSha, 321);
  const accepted = refreshRuntimeHistory({
    baseHistory: base,
    shardReports,
    supplementalReports,
    expectedCommitSha: heavyCommit,
    expectedSupplementalSourceSha: sourceSha,
    expectedSupplementalRunId: '9001',
    expectedSupplementalRunAttempt: '1',
    repoRoot: defaultRepoRoot,
  });
  assert(accepted.ok, 'valid fixed supplemental report must be accepted');
  assert(accepted.history.files[SUPPLEMENTAL_TARGET] === 321, 'supplemental weight must be measured');
  assert(accepted.history.provenance[SUPPLEMENTAL_TARGET] === 'measured', 'supplemental provenance must be measured');
  assert(
    JSON.stringify(accepted.history.recentSamples[SUPPLEMENTAL_TARGET]) === JSON.stringify([321]),
    'supplemental recent sample must be recorded',
  );
  assert(!accepted.coverage.message.includes(SUPPLEMENTAL_TARGET), 'supplemental target must not alter heavy coverage');

  const cases = [
    {
      name: 'wrong source',
      sourceSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expectedSha: sourceSha,
    },
    {
      name: 'failed metadata',
      sourceSha,
      overrides: { success: false },
    },
    {
      name: 'wrong lane',
      sourceSha,
      overrides: { lane: 'heavy' },
    },
    {
      name: 'duplicate rows',
      sourceSha,
      durationMs: [100, 200],
    },
    {
      name: 'non-positive duration',
      sourceSha,
      durationMs: 0,
    },
    {
      name: 'wrong target',
      sourceSha,
      overrides: { target: 'scripts/other.test.ts' },
    },
    {
      name: 'wrong workflow run',
      sourceSha,
      overrides: { runId: '9002' },
    },
    {
      name: 'oversized report',
      sourceSha,
      oversized: true,
    },
  ];
  for (const testCase of cases) {
    const caseDir = join(dir, testCase.name.replaceAll(' ', '-'));
    mkdirSync(caseDir, { recursive: true });
    const duration = Array.isArray(testCase.durationMs)
      ? testCase.durationMs
      : (testCase.durationMs ?? 321);
    const reportPath = join(caseDir, 'supplemental.json');
    const metaPath = join(caseDir, 'supplemental.meta.json');
    const target = testCase.overrides?.target ?? SUPPLEMENTAL_TARGET;
    const files = Array.isArray(duration)
      ? duration.map((value) => ({ file: target, durationMs: value }))
      : [{ file: target, durationMs: duration }];
    writeFileSync(
      reportPath,
      testCase.oversized
        ? `{"oversized":"${'x'.repeat(1024 * 1024)}"}`
        : stableStringify({ success: true, numFailedTests: 0, ...buildSyntheticVitestReport(files, join(defaultRepoRoot, 'supplemental-source')) }),
      'utf8',
    );
    writeFileSync(metaPath, stableStringify({
      schema: SUPPLEMENTAL_META_SCHEMA,
      repository: 'chetwerikoff/orchestrator-pack',
      target,
      commitSha: testCase.sourceSha,
      success: true,
      conclusion: 'success',
      lane: 'light',
      discovery: { source: 'scripts/vitest-ci-lanes.config.json', target, lane: 'light' },
      runId: '9001',
      runAttempt: '1',
      ...testCase.overrides,
    }), 'utf8');
    const result = refreshRuntimeHistory({
      baseHistory: base,
      shardReports: buildLanePlanShardReports(caseDir, heavyCommit, defaultRepoRoot),
      supplementalReports: new Map([[SUPPLEMENTAL_TARGET, { reportPath, metaPath, meta: JSON.parse(readFileSync(metaPath, 'utf8')) }]]),
      expectedCommitSha: heavyCommit,
      expectedSupplementalSourceSha: testCase.expectedSha ?? sourceSha,
      expectedSupplementalRunId: '9001',
      expectedSupplementalRunAttempt: '1',
      repoRoot: defaultRepoRoot,
    });
    assert(result.rejected, `${testCase.name} supplemental evidence must be rejected`);
    assert(result.outputBytes === baseBytes, `${testCase.name} rejection must preserve output bytes`);
  }

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

function runIssue1384StartingCensusFixture() {
  const committed = JSON.parse(
    readFileSync(join(defaultRepoRoot, 'scripts/vitest-runtime-history.json'), 'utf8'),
  );
  const historyFiles = Object.keys(committed.files ?? {}).sort();
  const currentFiles = discoverVitestFiles(defaultRepoRoot);
  const census = diffRuntimeHistoryInventories(historyFiles, currentFiles);
  const exactSets = {
    currentOnly: census.rightOnly,
    historyOnly: census.leftOnly,
  };
  const exactSetsSha256 = createHash('sha256')
    .update(JSON.stringify(exactSets))
    .digest('hex');

  assert(historyFiles.length === 209, `Issue #1384 baseline history count must remain 209 before generated delivery (got ${historyFiles.length})`);
  assert(currentFiles.length === 145, `Issue #1384 baseline canonical inventory must remain 145 before generated delivery (got ${currentFiles.length})`);
  assert(census.rightOnly.length === 74, `Issue #1384 baseline current files missing from history must remain 74 before generated delivery (got ${census.rightOnly.length})`);
  assert(census.leftOnly.length === 138, `Issue #1384 baseline history-only count must remain 138 before generated delivery (got ${census.leftOnly.length})`);
  assert(
    exactSetsSha256 === ISSUE_1384_STARTING_CENSUS_SHA256,
    `Issue #1384 exact starting census path sets drifted: expected ${ISSUE_1384_STARTING_CENSUS_SHA256}, got ${exactSetsSha256}`,
  );
  console.log(`runtime-history-issue-1384-starting-census ${JSON.stringify({
    historyCount: historyFiles.length,
    currentCount: currentFiles.length,
    currentOnly: census.rightOnly,
    historyOnly: census.leftOnly,
    exactSetsSha256,
  })}`);
}

function runTrustedInventoryMembershipFixture() {
  const fileA = 'scripts/a.test.ts';
  const fileB = 'scripts/b.test.ts';
  const newFile = 'scripts/new.test.ts';
  const deletedFile = 'scripts/deleted.test.ts';
  const base = normalizeHistory({
    issue: 556,
    source: MEASURED_SOURCE,
    dataChangedAt: '2026-07-01T00:00:00.000Z',
    smoothingRule: SMOOTHING_RULE,
    files: {
      [fileA]: 100,
      [fileB]: 200,
      [deletedFile]: 300,
    },
    provenance: {
      [fileA]: 'measured',
      [fileB]: 'seeded',
      [deletedFile]: 'measured',
    },
    recentSamples: {
      [fileA]: [100],
      [deletedFile]: [300],
    },
    fileChangedAt: {
      [fileA]: '2026-07-01T00:00:00.000Z',
      [deletedFile]: '2026-07-01T00:00:00.000Z',
    },
  });
  const current = [fileA, fileB, newFile];
  const reconciled = reconcileTrustedInventory(base, current);

  for (const field of ['files', 'provenance', 'recentSamples', 'fileChangedAt']) {
    assert(
      !Object.prototype.hasOwnProperty.call(reconciled[field], deletedFile),
      `deleted path must be pruned from ${field}`,
    );
  }
  assert(reconciled.provenance[newFile] === 'fallback', 'new unmeasured current path must be fallback');
  assert(!Object.prototype.hasOwnProperty.call(reconciled.files, newFile), 'new unmeasured current path must not receive fabricated duration');
  assert(!Object.prototype.hasOwnProperty.call(reconciled.recentSamples, newFile), 'new unmeasured current path must not receive fabricated samples');
  assert(!Object.prototype.hasOwnProperty.call(reconciled.fileChangedAt, newFile), 'new unmeasured current path must not receive fabricated change timestamp');
  assert(
    JSON.stringify(runtimeHistoryInventory(reconciled)) === JSON.stringify([...current].sort()),
    'trusted inventory must own exact history membership',
  );
  assert(
    historyBytes(reconcileTrustedInventory(reconciled, current)) === historyBytes(reconciled),
    'identical membership reconciliation must be byte-identical',
  );

  const promoted = mergeValidatedDurations(
    reconciled,
    new Map([[newFile, 321]]),
    [newFile],
  );
  const promotedInventory = reconcileTrustedInventory(promoted.history, current);
  assert(promotedInventory.files[newFile] === 321, 'later valid measurement must promote fallback weight');
  assert(promotedInventory.provenance[newFile] === 'measured', 'later valid measurement must promote fallback provenance');
}

function runInventoryDriftReconcileFixture() {
  const fileA = 'scripts/a.test.ts';
  const fileB = 'scripts/b.test.ts';
  const fileC = 'scripts/c.test.ts';
  const staleFile = 'scripts/stale.test.ts';
  const proposed = normalizeHistory({
    issue: 556,
    source: MEASURED_SOURCE,
    dataChangedAt: '2026-07-03T00:00:00.000Z',
    files: { [fileA]: 110, [fileB]: 200 },
    provenance: { [fileA]: 'measured', [fileB]: 'measured' },
    recentSamples: { [fileA]: [110], [fileB]: [200] },
    fileChangedAt: { [fileA]: '2026-07-03T00:00:00.000Z' },
  });
  const remote = normalizeHistory({
    issue: 556,
    source: MEASURED_SOURCE,
    dataChangedAt: '2026-07-04T00:00:00.000Z',
    files: { [fileA]: 100, [fileB]: 220, [staleFile]: 999 },
    provenance: { [fileA]: 'measured', [fileB]: 'measured', [staleFile]: 'measured' },
    recentSamples: { [fileA]: [100], [fileB]: [220], [staleFile]: [999] },
    fileChangedAt: {
      [fileB]: '2026-07-04T00:00:00.000Z',
      [staleFile]: '2026-07-04T00:00:00.000Z',
    },
  });

  const equal = reconcileProposedHistoryAgainstRemote(proposed, remote, {
    currentInventory: [fileA, fileB],
    requireEqualInventory: true,
  });
  assert(equal.files[fileA] === 110, 'equal-inventory reconcile must retain proposed newer file A measurement');
  assert(equal.files[fileB] === 220, 'equal-inventory reconcile must retain remote newer file B measurement');
  assert(!Object.prototype.hasOwnProperty.call(equal.files, staleFile), 'equal-inventory reconcile must prune stale remote membership');

  for (const [name, inventory] of [
    ['addition', [fileA, fileB, fileC]],
    ['deletion', [fileA]],
    ['reintroduction', [fileA, fileC]],
  ]) {
    assertThrows(
      () => reconcileProposedHistoryAgainstRemote(proposed, remote, {
        currentInventory: inventory,
        requireEqualInventory: true,
      }),
      'inventory drift:',
      `${name} inventory drift must refuse`,
    );
  }
}

function runPartialSupplementalTupleWrapperFixture() {
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-partial-tuple`);
  mkdirSync(dir, { recursive: true });
  const historyPath = join(dir, 'history.json');
  const sentinel = '{"sentinel":"unchanged"}\n';
  writeFileSync(historyPath, sentinel, 'utf8');
  const wrapper = join(defaultRepoRoot, 'scripts/refresh-vitest-runtime-history.ps1');
  const tuple = [
    ['-SupplementalReportsDir', join(dir, 'supplemental')],
    ['-SupplementalSourceSha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['-SupplementalRunId', '9001'],
    ['-SupplementalRunAttempt', '1'],
  ];

  for (let mask = 1; mask < (1 << tuple.length) - 1; mask += 1) {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-File', wrapper,
      '-ReportsDir', join(dir, 'heavy'),
      '-CommitSha', 'deadbeef',
      '-RepoRoot', dir,
      '-HistoryPath', historyPath,
      '-CommitBack',
    ];
    for (let index = 0; index < tuple.length; index += 1) {
      if ((mask & (1 << index)) !== 0) args.push(...tuple[index]);
    }
    const result = runProcessSync({
      command: 'pwsh',
      args,
      encoding: 'utf8',
      inheritParentEnv: true,
      timeoutMs: 30_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert(result.exitCode !== 0, `partial supplemental tuple mask ${mask} must fail`);
    assert(output.includes(SUPPLEMENTAL_TUPLE_ERROR), `partial supplemental tuple mask ${mask} must emit exact refusal`);
    assert(readFileSync(historyPath, 'utf8') === sentinel, `partial supplemental tuple mask ${mask} must preserve history bytes`);
  }

  rmSync(dir, { recursive: true, force: true });
}

function runWrapperAbsentAndCompleteTupleFixture() {
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-wrapper-contract`);
  const reportsDir = join(dir, 'heavy');
  const supplementalDir = join(dir, 'supplemental');
  mkdirSync(reportsDir, { recursive: true });
  const commitSha = 'deadbeef';
  buildLanePlanShardReports(reportsDir, commitSha, defaultRepoRoot);
  writeCanonicalSupplementalReport(
    supplementalDir,
    'aede47815ccadb54ac0ce405e8e359a343d196fe',
  );
  const historyPath = join(dir, 'history.json');
  const committedHistory = readFileSync(
    join(defaultRepoRoot, 'scripts/vitest-runtime-history.json'),
    'utf8',
  );
  writeFileSync(historyPath, committedHistory, 'utf8');
  const wrapper = join(defaultRepoRoot, 'scripts/refresh-vitest-runtime-history.ps1');
  const common = [
    '-NoProfile',
    '-NonInteractive',
    '-File', wrapper,
    '-ReportsDir', reportsDir,
    '-CommitSha', commitSha,
    '-RepoRoot', defaultRepoRoot,
    '-HistoryPath', historyPath,
    '-DryRun',
  ];

  const ordinary = runProcessSync({
    command: 'pwsh',
    args: common,
    encoding: 'utf8',
    inheritParentEnv: true,
    timeoutMs: 60_000,
  });
  assert(ordinary.exitCode === 0, `ordinary heavy-only wrapper invocation must pass: ${ordinary.stderr ?? ''}`);

  const complete = runProcessSync({
    command: 'pwsh',
    args: [
      ...common,
      '-SupplementalReportsDir', supplementalDir,
      '-SupplementalSourceSha', 'aede47815ccadb54ac0ce405e8e359a343d196fe',
      '-SupplementalRunId', '9001',
      '-SupplementalRunAttempt', '1',
    ],
    encoding: 'utf8',
    inheritParentEnv: true,
    timeoutMs: 60_000,
  });
  assert(complete.exitCode === 0, `complete supplemental wrapper invocation must pass: ${complete.stderr ?? ''}`);

  rmSync(dir, { recursive: true, force: true });
}

function runWorkflowBoundaryFixture() {
  const source = readFileSync(
    join(defaultRepoRoot, '.github/workflows/vitest-runtime-history-refresh.yml'),
    'utf8',
  );
  assert(source.includes('$refreshArgs = @{'), 'workflow must construct a named PowerShell hashtable');
  assert(
    source.includes('./scripts/refresh-vitest-runtime-history.ps1 @refreshArgs'),
    'workflow must invoke wrapper with named hashtable splatting',
  );
  assert(
    !source.includes('./scripts/refresh-vitest-runtime-history.ps1 @args'),
    'workflow must not use positional array splatting for wrapper parameters',
  );
  assert(
    source.includes('runtime-history-refresh-boundary '),
    'workflow must emit safe effective invocation boundary evidence',
  );
  for (const field of ['event', 'ref', 'trustedSha', 'workflowRef', 'workflowSha', 'supplementalTuple', 'arguments']) {
    assert(source.includes(field), `workflow boundary signal must include ${field}`);
  }
  assert(
    source.includes('runtime-history delivery inventory guard: trusted main'),
    'delivery reconciliation must bind prepared membership to a freshly fetched trusted main tree',
  );
  assert(
    source.includes('runtime-history pre-delivery inventory guard: trusted main'),
    'delivery push must re-check freshly fetched trusted main immediately before branch mutation',
  );
  assert(
    (source.match(/--repo-root "\$\{trusted_main_root\}"/g) ?? []).length >= 3,
    'late delivery reconciliation must discover inventory from trusted main worktrees',
  );
  assert(
    source.includes("if: github.event_name == 'workflow_dispatch' && inputs.supplemental_source_sha != ''"),
    'supplemental artifact steps must be manual-input gated',
  );
  assert(source.includes('push:'), 'ordinary push trigger must remain enabled');
  assert(source.includes('schedule:'), 'scheduled trigger must remain enabled');
  assert(source.includes('workflow_dispatch:'), 'manual trigger must remain enabled');
}

function runRejectedTerminalStatusFixture() {
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-terminal-failure`);
  mkdirSync(dir, { recursive: true });
  const cli = join(defaultRepoRoot, 'scripts/refresh-vitest-runtime-history.mjs');
  const historyPath = join(defaultRepoRoot, 'scripts/vitest-runtime-history.json');

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = runProcessSync({
      command: process.execPath,
      args: [
        cli,
        '--reports-dir', dir,
        '--commit-sha', 'deadbeef',
        '--repo-root', defaultRepoRoot,
        '--history-path', historyPath,
        '--dry-run',
      ],
      encoding: 'utf8',
      inheritParentEnv: true,
      timeoutMs: 30_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert(result.exitCode !== 0, `rejected evidence attempt ${attempt} must remain non-successful`);
    assert(output.includes('[FAIL] runtime-history refresh rejected evidence:'), `rejected evidence attempt ${attempt} must emit failure signal`);
    assert(!output.includes('[PASS] runtime-history refresh left committed history unchanged'), `rejected evidence attempt ${attempt} must not masquerade as idempotent success`);
  }

  rmSync(dir, { recursive: true, force: true });
}

function runGeneratedCandidateInventoryAndBoundFixture() {
  const dir = join(tmpdir(), `vhr-fixture-${Date.now()}-pr1376-replay`);
  const sourceRoot = join(dir, 'source');
  const reportsDir = join(dir, 'reports');
  mkdirSync(dir, { recursive: true });
  let worktreeAdded = false;

  try {
    const addWorktree = runProcessSync({
      command: 'git',
      args: [
        '-C', defaultRepoRoot,
        'worktree', 'add', '--detach', sourceRoot, PR_1376_REPLAY_BASE_SHA,
      ],
      encoding: 'utf8',
      inheritParentEnv: true,
      timeoutMs: 30_000,
    });
    assert(
      addWorktree.exitCode === 0,
      `PR #1376 replay must materialize historical base ${PR_1376_REPLAY_BASE_SHA}: ${addWorktree.stderr ?? ''}`,
    );
    if (addWorktree.exitCode !== 0) return;
    worktreeAdded = true;

    const mergeWorktree = runProcessSync({
      command: 'git',
      args: [
        '-C', sourceRoot,
        'merge', '--no-commit', '--no-ff', PR_1376_REPLAY_HEAD_SHA,
      ],
      encoding: 'utf8',
      inheritParentEnv: true,
      timeoutMs: 30_000,
    });
    assert(
      mergeWorktree.exitCode === 0,
      `PR #1376 replay must reconstruct the reviewed merge tree: ${mergeWorktree.stderr ?? ''}`,
    );
    if (mergeWorktree.exitCode !== 0) return;

    const historicalTopology = buildHeavyTopology(sourceRoot, {
      changedFiles: PR_1376_CHANGED_FILES,
    });
    assert(historicalTopology.ok, 'PR #1376 historical topology must be available');
    if (!historicalTopology.ok) return;

    const historicalUnresolved = historicalTopology.topology.unresolvedGuardWeights;
    assert(
      historicalUnresolved.length === 33,
      `PR #1376 historical replay must reproduce exactly 33 pre-topology targets before repair (got ${historicalUnresolved.length})`,
    );
    assertThrows(
      () => resolvePreTopologyMeasurementPlan({
        topology: historicalTopology.topology,
        lanesConfig: historicalTopology.lanesConfig,
      }),
      '33 files > 32',
      'PR #1376 historical replay must reproduce the exact 33 > 32 bound refusal',
    );

    mkdirSync(reportsDir, { recursive: true });
    const committed = JSON.parse(
      readFileSync(join(sourceRoot, 'scripts/vitest-runtime-history.json'), 'utf8'),
    );
    const candidate = refreshRuntimeHistory({
      baseHistory: committed,
      shardReports: buildLanePlanShardReports(
        reportsDir,
        PR_1376_REPLAY_HEAD_SHA,
        sourceRoot,
      ),
      expectedCommitSha: PR_1376_REPLAY_HEAD_SHA,
      repoRoot: sourceRoot,
    });
    const historicalCurrent = discoverVitestFiles(sourceRoot);
    assert(
      candidate.ok && !candidate.rejected,
      'PR #1376 replay candidate must be generated by accepted repaired-producer evidence',
    );
    assert(
      JSON.stringify(runtimeHistoryInventory(candidate.history)) === JSON.stringify([...historicalCurrent].sort()),
      'PR #1376 replay candidate membership must exactly match its historical canonical source inventory',
    );

    const candidateArtifact = {
      source: candidate.history.source,
      files: candidate.history.files,
      provenance: candidate.history.provenance,
      dataChangedAt: candidate.history.dataChangedAt,
    };
    const candidateUnresolved = findOversizedFiles(
      historicalCurrent,
      candidateArtifact,
      historicalTopology.policy,
      sourceRoot,
      {
        classification: historicalTopology.lanesConfig.classification,
        changedFiles: PR_1376_CHANGED_FILES,
      },
    ).unresolved;
    let candidatePlan = null;
    try {
      candidatePlan = resolvePreTopologyMeasurementPlan({
        topology: { unresolvedGuardWeights: candidateUnresolved },
        lanesConfig: historicalTopology.lanesConfig,
      });
    } catch (error) {
      fail(`repaired producer must bring PR #1376 replay within unchanged bound: ${String(error?.message ?? error)}`);
    }

    assert(PRE_TOPOLOGY_MAX_FILES === 32, `PRE_TOPOLOGY_MAX_FILES must remain exactly 32 (got ${PRE_TOPOLOGY_MAX_FILES})`);
    if (candidatePlan) {
      assert(
        candidatePlan.targets.length <= PRE_TOPOLOGY_MAX_FILES,
        `repaired producer must turn PR #1376 replay from 33 > 32 into <= 32 (${candidatePlan.targets.length} > ${PRE_TOPOLOGY_MAX_FILES})`,
      );
      console.log(`runtime-history-issue-1384-pr1376-replay ${JSON.stringify({
        baseSha: PR_1376_REPLAY_BASE_SHA,
        headSha: PR_1376_REPLAY_HEAD_SHA,
        changedFiles: PR_1376_CHANGED_FILES,
        historicalTargets: historicalUnresolved.length,
        repairedCandidateTargets: candidatePlan.targets.length,
        bound: PRE_TOPOLOGY_MAX_FILES,
      })}`);
    }
  } finally {
    if (worktreeAdded) {
      runProcessSync({
        command: 'git',
        args: ['-C', sourceRoot, 'merge', '--abort'],
        encoding: 'utf8',
        inheritParentEnv: true,
        timeoutMs: 30_000,
      });
      runProcessSync({
        command: 'git',
        args: ['-C', defaultRepoRoot, 'worktree', 'remove', '--force', sourceRoot],
        encoding: 'utf8',
        inheritParentEnv: true,
        timeoutMs: 30_000,
      });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCommitBackNoOpOrderingFixture() {
  const source = readFileSync(join(defaultRepoRoot, 'scripts/refresh-vitest-runtime-history.ps1'), 'utf8');
  const statusIndex = source.indexOf("$status = git -C $RepoRoot status --porcelain -- 'scripts/vitest-runtime-history.json'");
  const noOpIndex = source.indexOf(
    "[PASS] runtime-history commit-back skipped (idempotent no-op after stale-base reconcile)",
    statusIndex,
  );
  const assertIndex = source.indexOf('Assert-OnlyRuntimeHistoryStaged', statusIndex);
  assert(statusIndex >= 0, 'commit-back flow must inspect runtime-history status after git add');
  assert(noOpIndex > statusIndex, 'commit-back flow must preserve the stale-base reconcile no-op exit');
  assert(assertIndex > noOpIndex, 'commit-back staged-path assertion must run only after the no-op exit check');
}

export function runRuntimeHistoryRefreshFixtures() {
  failures.length = 0;
  runMeasuredRefreshFixture();
  runIdenticalRerunIdempotentFixture();
  runMeasuredSourceWithoutWeightChangeFixture();
  runMetadataOnlyReconcileFixture();
  runStaleBaseReconcileFixture();
  runSmoothingFixture();
  runCorruptInputFixtures();
  runRaceSafeFixture();
  runProvenanceGateFixtures();
  runSupplementalTargetFixtures();
  runCoverageAndDurableProvenanceFixture();
  runIssue1384StartingCensusFixture();
  runTrustedInventoryMembershipFixture();
  runInventoryDriftReconcileFixture();
  runPartialSupplementalTupleWrapperFixture();
  runWrapperAbsentAndCompleteTupleFixture();
  runWorkflowBoundaryFixture();
  runRejectedTerminalStatusFixture();
  runGeneratedCandidateInventoryAndBoundFixture();
  runCommitBackNoOpOrderingFixture();
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
