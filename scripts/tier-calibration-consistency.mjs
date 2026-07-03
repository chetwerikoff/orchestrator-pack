#!/usr/bin/env node
/**
 * Task complexity tier calibration sample consistency guard (Issue #574).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID_TIERS = new Set(['T1', 'T2', 'T3']);

function parseArgs(argv) {
  const opts = { repoRoot: resolve(__dirname, '..'), samplePath: null, selfTest: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-root') {
      opts.repoRoot = resolve(argv[++i]);
    } else if (arg === '--sample') {
      opts.samplePath = resolve(argv[++i]);
    } else if (arg === '--self-test') {
      opts.selfTest = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.samplePath) {
    opts.samplePath = join(
      opts.repoRoot,
      'tests/fixtures/task-complexity-tier-calibration.json',
    );
  }
  return opts;
}

function loadSample(samplePath) {
  const raw = readFileSync(samplePath, 'utf8');
  return JSON.parse(raw);
}

function validateSample(doc, { label = 'sample' } = {}) {
  const failures = [];
  const markerClasses = doc.markerClasses;
  if (!Array.isArray(markerClasses) || markerClasses.length === 0) {
    failures.push(`${label}: markerClasses must be a non-empty array`);
    return failures;
  }
  const markerSet = new Set(markerClasses);
  const samples = doc.samples;
  if (!Array.isArray(samples) || samples.length < 8) {
    failures.push(`${label}: samples must contain at least 8 rows`);
    return failures;
  }

  let t1 = 0;
  let t2 = 0;
  let boundaryT3 = 0;

  for (const row of samples) {
    const id = row.id ?? '<missing-id>';
    if (!VALID_TIERS.has(row.tier)) {
      failures.push(`${label}:${id}: tier must be T1, T2, or T3`);
    }
    if (!row.decider || typeof row.decider !== 'string') {
      failures.push(`${label}:${id}: decider is required`);
    }
    if (!Array.isArray(row.markersPresent)) {
      failures.push(`${label}:${id}: markersPresent must be an array`);
      continue;
    }
    if (!Array.isArray(row.checkedSilent)) {
      failures.push(`${label}:${id}: checkedSilent attestation is required`);
      continue;
    }

    for (const marker of row.markersPresent) {
      if (!markerSet.has(marker)) {
        failures.push(`${label}:${id}: unknown marker in markersPresent: ${marker}`);
      }
      if (row.tier !== 'T3') {
        failures.push(
          `${label}:${id}: red-flag marker "${marker}" present but tier is ${row.tier} (must be T3)`,
        );
      }
    }

    for (const checked of row.checkedSilent) {
      if (!markerSet.has(checked)) {
        failures.push(`${label}:${id}: unknown marker in checkedSilent: ${checked}`);
      }
      if (row.markersPresent.includes(checked)) {
        failures.push(
          `${label}:${id}: marker "${checked}" cannot be both present and checked silent`,
        );
      }
    }

    const silentSet = new Set(row.checkedSilent);
    const expectedSilent = markerClasses.filter((m) => !row.markersPresent.includes(m));
    for (const expected of expectedSilent) {
      if (!silentSet.has(expected)) {
        failures.push(
          `${label}:${id}: checkedSilent missing attestation for absent marker class "${expected}"`,
        );
      }
    }

    if (row.tier === 'T1') t1 += 1;
    if (row.tier === 'T2') t2 += 1;
    if (row.tier === 'T3' && row.boundaryCase === true) boundaryT3 += 1;
  }

  if (t1 < 2) failures.push(`${label}: need at least 2 T1 rows (found ${t1})`);
  if (t2 < 2) failures.push(`${label}: need at least 2 T2 rows (found ${t2})`);
  if (boundaryT3 < 3) {
    failures.push(`${label}: need at least 3 boundary-marker T3 rows (found ${boundaryT3})`);
  }
  const lightShare = (t1 + t2) / samples.length;
  if (lightShare < 0.25) {
    failures.push(
      `${label}: T1+T2 must be at least 25% of rows (found ${(lightShare * 100).toFixed(1)}%)`,
    );
  }

  return failures;
}

function runSelfTest(repoRoot, samplePath) {
  const base = loadSample(samplePath);
  const baseFailures = validateSample(base);
  if (baseFailures.length > 0) {
    console.error('[FAIL] committed sample must pass before self-test mutations');
    for (const f of baseFailures) console.error(` - ${f}`);
    return 1;
  }

  const underTier = structuredClone(base);
  const boundary = underTier.samples.find((r) => r.boundaryCase === true);
  if (!boundary) {
    console.error('[FAIL] self-test: no boundaryCase row found');
    return 1;
  }
  boundary.tier = 'T2';
  const underTierFailures = validateSample(underTier, { label: 'under-tier-mutation' });
  if (underTierFailures.length === 0) {
    console.error('[FAIL] self-test: under-tier boundary relabel should fail validation');
    return 1;
  }

  const collapsed = structuredClone(base);
  for (const row of collapsed.samples) {
    if (row.tier === 'T1' || row.tier === 'T2') row.tier = 'T3';
  }
  const collapseFailures = validateSample(collapsed, { label: 'anti-collapse-mutation' });
  if (collapseFailures.length === 0) {
    console.error('[FAIL] self-test: anti-collapse relabel should fail validation');
    return 1;
  }

  console.log('[PASS] tier calibration consistency self-test (under-tier + anti-collapse mutations)');
  return 0;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) {
    process.exit(runSelfTest(opts.repoRoot, opts.samplePath));
  }

  let doc;
  try {
    doc = loadSample(opts.samplePath);
  } catch (err) {
    console.error(`[FAIL] cannot read calibration sample: ${err.message}`);
    process.exit(1);
  }

  const failures = validateSample(doc);
  if (failures.length > 0) {
    console.error('[FAIL] tier calibration sample consistency:');
    for (const f of failures) console.error(` - ${f}`);
    process.exit(1);
  }

  console.log(
    `[PASS] tier calibration sample consistency (${doc.samples.length} rows, marker guard + distribution floor)`,
  );
  process.exit(0);
}

main();
