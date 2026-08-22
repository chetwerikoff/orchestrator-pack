#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  ISSUE_1498_PRE_TOPOLOGY_MEASUREMENT_ESTIMATES,
  PRE_TOPOLOGY_MAX_FILES,
  PRE_TOPOLOGY_MEASUREMENT_ESTIMATES,
  resolvePreTopologyMeasurementPlan,
} from './lib/vitest-pre-topology-measurement.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, 'scripts', 'refresh-vitest-runtime-history.mjs');
const testPath = 'scripts/legacy-runtime-history.test.ts';
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function history({
  weight = null,
  provenance = 'fallback',
  samples = null,
  changedAt = null,
  dataChangedAt,
  contentSha = undefined,
}) {
  const value = {
    issue: 556,
    source: 'ci-measured',
    dataChangedAt,
    smoothingRule: 'median-of-last-5-samples',
    files: weight == null ? {} : { [testPath]: weight },
    provenance: { [testPath]: provenance },
    recentSamples: samples == null ? {} : { [testPath]: samples },
    fileChangedAt: changedAt == null ? {} : { [testPath]: changedAt },
  };
  if (contentSha !== undefined) value.contentSha = contentSha;
  return value;
}

{
  const sourceConfig = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'vitest-ci-lanes.config.json'), 'utf8'),
  );
  const unresolved = Object.keys(ISSUE_1498_PRE_TOPOLOGY_MEASUREMENT_ESTIMATES).map((file) => ({
    file,
  }));
  const plan = resolvePreTopologyMeasurementPlan(
    { topology: { unresolvedGuardWeights: unresolved }, config: sourceConfig },
    { maxFiles: Number.MAX_SAFE_INTEGER },
  );
  for (const [file, expected] of Object.entries(
    ISSUE_1498_PRE_TOPOLOGY_MEASUREMENT_ESTIMATES,
  )) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    const directive = source.match(/@vitest-pre-topology-seconds\s+([1-9][0-9]*(?:\.[0-9]+)?)/)?.[1];
    assert(PRE_TOPOLOGY_MEASUREMENT_ESTIMATES[file] === expected, `${file}: map estimate must be ${expected}`);
    assert(Number(directive) === expected, `${file}: inline estimate must be ${expected}`);
    const lane = sourceConfig.classification?.[file];
    if (file === 'scripts/pester-retirement.test.ts') {
      assert(lane === 'heavy', `${file}: lane must remain heavy`);
      assert(plan.targets.includes(file), `${file}: heavy target must remain live-measured`);
      assert(!(file in plan.measurements), `${file}: heavy target must not use fixed estimate`);
    } else {
      assert(lane === 'light', `${file}: lane must remain light`);
      assert(plan.measurements[file] === expected, `${file}: light target must use fixed estimate`);
    }
  }
}

function runReconcile({ remote, proposed, trusted = true, extraProposedPath = null }) {
  const root = join(tmpdir(), `vhr-legacy-reconcile-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fakeScripts = join(root, 'scripts');
  const fakePlugins = join(root, 'plugins');
  mkdirSync(fakeScripts, { recursive: true });
  mkdirSync(fakePlugins, { recursive: true });
  writeFileSync(join(fakeScripts, 'legacy-runtime-history.test.ts'), 'export {};\n', 'utf8');

  if (extraProposedPath) {
    proposed.provenance[extraProposedPath] = 'fallback';
  }

  const remotePath = join(root, 'remote.json');
  const proposedPath = join(root, 'proposed.json');
  const outputPath = join(root, 'output.json');
  writeFileSync(remotePath, `${JSON.stringify(remote, null, 2)}\n`, 'utf8');
  writeFileSync(proposedPath, `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');

  const args = [
    cli,
    'reconcile',
    '--remote', remotePath,
    '--proposed', proposedPath,
    '--output', outputPath,
    '--repo-root', root,
  ];
  if (trusted) args.push('--require-equal-inventory');

  const result = runProcessSync({
    command: process.execPath,
    args,
    cwd: repoRoot,
    encoding: 'utf8',
    inheritParentEnv: true,
    timeoutMs: 30_000,
  });
  const output = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, 'utf8'))
    : null;
  rmSync(root, { recursive: true, force: true });
  return { result, output };
}

function runProductionGuard({ root, remote, trustedHistory, outputName = 'output.json' }) {
  const scriptsDir = join(root, 'scripts');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  const historyPath = join(scriptsDir, 'vitest-runtime-history.json');
  const remotePath = join(root, 'remote.json');
  const outputPath = join(root, outputName);
  writeFileSync(historyPath, `${JSON.stringify(trustedHistory, null, 2)}\n`, 'utf8');
  writeFileSync(remotePath, `${JSON.stringify(remote, null, 2)}\n`, 'utf8');

  const result = runProcessSync({
    command: process.execPath,
    args: [
      cli,
      'reconcile',
      '--remote', remotePath,
      '--proposed', historyPath,
      '--output', outputPath,
      '--repo-root', root,
      '--require-equal-inventory',
    ],
    cwd: root,
    env: { GITHUB_ACTIONS: 'true' },
    encoding: 'utf8',
    inheritParentEnv: true,
    timeoutMs: 30_000,
  });
  return { result, historyPath, outputPath };
}

// Timing metadata attached to fallback/no-weight state is not authoritative in trusted mode:
// reconcileTrustedInventory removes it even when no legacy measured repair is available.
const fallbackMetadataWithoutRepair = runReconcile({
  remote: history({
    samples: [28000],
    changedAt: '2026-08-18T16:30:00.000Z',
    dataChangedAt: '2026-08-18T16:30:00.000Z',
  }),
  proposed: history({
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
});
assert(fallbackMetadataWithoutRepair.result.exitCode === 0, 'trusted fallback metadata reconcile must succeed');
assert(!(testPath in (fallbackMetadataWithoutRepair.output?.files ?? {})), 'trusted fallback state must remain without a weight');
assert(fallbackMetadataWithoutRepair.output?.provenance?.[testPath] === 'fallback', 'trusted fallback provenance must remain fallback');
assert(!(testPath in (fallbackMetadataWithoutRepair.output?.recentSamples ?? {})), 'trusted inventory reconcile must discard fallback recentSamples');
assert(!(testPath in (fallbackMetadataWithoutRepair.output?.fileChangedAt ?? {})), 'trusted inventory reconcile must discard fallback fileChangedAt');

const trustedLegacyOverFallbackMetadata = runReconcile({
  remote: history({
    samples: [28000],
    changedAt: '2026-08-18T16:30:00.000Z',
    dataChangedAt: '2026-08-18T16:30:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
});
assert(trustedLegacyOverFallbackMetadata.result.exitCode === 0, 'trusted legacy reconcile over fallback metadata must succeed');
assert(trustedLegacyOverFallbackMetadata.output?.files?.[testPath] === 45000, 'trusted legacy weight must replace fallback state after metadata normalization');
assert(trustedLegacyOverFallbackMetadata.output?.provenance?.[testPath] === 'measured', 'trusted legacy provenance must replace fallback provenance');
assert(!(testPath in (trustedLegacyOverFallbackMetadata.output?.recentSamples ?? {})), 'legacy repair must not resurrect discarded fallback recentSamples');
assert(!(testPath in (trustedLegacyOverFallbackMetadata.output?.fileChangedAt ?? {})), 'legacy repair must not resurrect discarded fallback fileChangedAt');

const trustedLegacy = runReconcile({
  remote: history({
    dataChangedAt: '2026-08-18T14:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
});
assert(trustedLegacy.result.exitCode === 0, 'trusted legacy reconcile must succeed');
assert(trustedLegacy.output?.files?.[testPath] === 45000, 'trusted legacy weight must be preserved');
assert(trustedLegacy.output?.provenance?.[testPath] === 'measured', 'trusted legacy provenance must stay measured');
assert(!(testPath in (trustedLegacy.output?.recentSamples ?? {})), 'legacy repair must not invent recentSamples');
assert(!(testPath in (trustedLegacy.output?.fileChangedAt ?? {})), 'legacy repair must not invent fileChangedAt');
assert(
  `${trustedLegacy.result.stdout}${trustedLegacy.result.stderr}`.includes('candidate-positive=1 trusted-positive=1'),
  'trusted reconcile result counter must be derived from the final candidate payload',
);

const contentShaShape = runReconcile({
  remote: history({
    dataChangedAt: '2026-08-18T14:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
    contentSha: { [testPath]: 'trusted-content-sha' },
  }),
});
assert(contentShaShape.result.exitCode === 0, 'contentSha shape reconcile must succeed');
assert(
  contentShaShape.output?.contentSha?.[testPath] === 'trusted-content-sha',
  'caller boundary must preserve trusted contentSha shape and value',
);

const validRemote = runReconcile({
  remote: history({
    weight: 31000,
    provenance: 'measured',
    samples: [31000],
    changedAt: '2026-08-18T16:00:00.000Z',
    dataChangedAt: '2026-08-18T16:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
});
assert(validRemote.result.exitCode === 0, 'valid remote reconcile must succeed');
assert(validRemote.output?.files?.[testPath] === 31000, 'legacy carry-forward must not overwrite valid remote weight');
assert(validRemote.output?.fileChangedAt?.[testPath] === '2026-08-18T16:00:00.000Z', 'newer remote timestamp must remain authoritative');

const untrustedLegacy = runReconcile({
  remote: history({
    dataChangedAt: '2026-08-18T14:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
  trusted: false,
});
assert(untrustedLegacy.result.exitCode === 0, 'untrusted reconcile must retain legacy behavior');
assert(!(testPath in (untrustedLegacy.output?.files ?? {})), 'untrusted reconcile must not restore legacy weight');
assert(untrustedLegacy.output?.provenance?.[testPath] === 'fallback', 'untrusted reconcile must keep remote fallback provenance');

const inventoryDrift = runReconcile({
  remote: history({
    dataChangedAt: '2026-08-18T14:00:00.000Z',
  }),
  proposed: history({
    weight: 45000,
    provenance: 'measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  }),
  extraProposedPath: 'scripts/not-in-trusted-inventory.test.ts',
});
assert(inventoryDrift.result.exitCode !== 0, 'inventory drift must remain fail-closed');
assert(
  `${inventoryDrift.result.stderr}${inventoryDrift.result.stdout}`.includes('inventory drift:'),
  'inventory drift failure must remain explicit',
);

// S2: a trusted seeded positive tuple that the generic reconcile would downgrade
// must be stopped at the caller boundary before the output artifact is written.
{
  const root = join(tmpdir(), `vhr-publication-s2-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'plugins'), { recursive: true });
  writeFileSync(join(root, testPath), 'export {};\n', 'utf8');
  const trusted = history({
    weight: 45000,
    provenance: 'seeded',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
  });
  const remote = history({
    dataChangedAt: '2026-08-18T16:00:00.000Z',
  });
  const guarded = runProductionGuard({ root, remote, trustedHistory: trusted });
  const signal = `${guarded.result.stderr}${guarded.result.stdout}`;
  assert(guarded.result.exitCode !== 0, 'S2 tuple loss/downgrade must fail closed');
  assert(signal.includes(testPath), `S2 refusal must name the affected canonical path: ${signal}`);
  assert(
    signal.includes('trusted-main candidate invariant violated'),
    `S2 refusal must name the violated trusted-main invariant: ${signal}`,
  );
  assert(!existsSync(guarded.outputPath), 'S2 refusal must occur before candidate output mutation');
  rmSync(root, { recursive: true, force: true });
}

// S3: exercise the existing pre-topology authority with 33 live unresolved
// targets. No new bound or approximation is introduced by this fixture.
{
  const root = join(tmpdir(), `vhr-publication-s3-${process.pid}-${Date.now()}`);
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, 'plugins'), { recursive: true });
  const sourceConfig = JSON.parse(
    readFileSync(join(repoRoot, 'scripts', 'vitest-ci-lanes.config.json'), 'utf8'),
  );
  const targets = Object.entries(sourceConfig.classification ?? {})
    .filter(([file, lane]) => {
      if (!file.endsWith('.test.ts')) return false;
      if (lane === 'postMergeWallclock' || lane === 'parked') return false;
      return !(
        lane === 'light'
        && Number.isFinite(PRE_TOPOLOGY_MEASUREMENT_ESTIMATES[file])
        && PRE_TOPOLOGY_MEASUREMENT_ESTIMATES[file] > 0
      );
    })
    .map(([file]) => file)
    .slice(0, PRE_TOPOLOGY_MAX_FILES + 1);
  assert(
    targets.length === PRE_TOPOLOGY_MAX_FILES + 1,
    `S3 fixture must resolve exactly ${PRE_TOPOLOGY_MAX_FILES + 1} non-estimated guard targets`,
  );
  const targetSet = new Set(targets);
  const lanesConfig = {
    ...sourceConfig,
    classification: Object.fromEntries(
      targets.map((file) => [file, sourceConfig.classification[file]]),
    ),
    heavyPerTestIsolate: (sourceConfig.heavyPerTestIsolate ?? []).filter((file) => targetSet.has(file)),
    heavyFileBatchIsolate: (sourceConfig.heavyFileBatchIsolate ?? []).filter((file) => targetSet.has(file)),
    parkedWallclockE2e: sourceConfig.parkedWallclockE2e
      ? {
          ...sourceConfig.parkedWallclockE2e,
          files: (sourceConfig.parkedWallclockE2e.files ?? []).filter((file) => targetSet.has(file)),
        }
      : sourceConfig.parkedWallclockE2e,
  };
  writeFileSync(
    join(scriptsDir, 'vitest-ci-lanes.config.json'),
    `${JSON.stringify(lanesConfig, null, 2)}\n`,
    'utf8',
  );
  for (const file of targets) {
    const fullPath = join(root, file);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, 'export {};\n', 'utf8');
  }
  const trusted = {
    issue: 556,
    source: 'ci-measured',
    dataChangedAt: '2026-08-18T15:00:00.000Z',
    smoothingRule: 'median-of-last-5-samples',
    files: {},
    provenance: Object.fromEntries(targets.map((file) => [file, 'fallback'])),
    recentSamples: {},
    fileChangedAt: {},
  };
  const remote = structuredClone(trusted);
  const guarded = runProductionGuard({ root, remote, trustedHistory: trusted });
  const signal = `${guarded.result.stderr}${guarded.result.stdout}`;
  assert(guarded.result.exitCode !== 0, 'S3 pre-topology bound must fail closed');
  assert(
    signal.includes(`observed=${PRE_TOPOLOGY_MAX_FILES + 1} bound=${PRE_TOPOLOGY_MAX_FILES}`),
    `S3 refusal must report the observed count and unchanged bound: ${signal}`,
  );
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exit(1);
}

console.log('[PASS] runtime-history trusted legacy reconcile + publication guard fixture');
