#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

import { cliFail, loadJsonFile } from './cli-guard-helpers.mjs';

const BARE_SLEEP_RE = /new\s+Promise\s*\(\s*\(\s*resolve\s*\)\s*=>\s*setTimeout\s*\(/;
const FIXED_WINDOW_RE = /fixedObservationWindow\s*\(/;
const POSITIVE_HELPER_RE =
  /waitForCondition|waitForStdoutContains|waitForMarkerPidChange|waitForSupervisorLogMatchFromOffset|waitForSupervisorLogMatch|waitForMarker|waitForMarkers|waitForProcessesStopped|waitForSupervisorHealthyStatus|stopSupervisorChild/;

function loadJson(path) {
  return loadJsonFile(path);
}

function hashExpectLines(filePath) {
  const text = readFileSync(join(repoRoot, filePath), 'utf8');
  const expects = text
    .split('\n')
    .filter((line) => /\bexpect\(/.test(line))
    .map((line) => line.trim());
  return createHash('sha256').update(expects.join('\n')).digest('hex');
}

function findBareSleeps(filePath) {
  const abs = join(repoRoot, filePath);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (BARE_SLEEP_RE.test(lines[i])) {
      hits.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

function siteCoversBareSleep(site, bareHit, fileText) {
  if (site.file !== bareHit.file) return false;
  if (site.anchor && fileText.includes(site.anchor)) {
    const anchorIndex = fileText.indexOf(site.anchor);
    const lineStart = fileText.slice(0, anchorIndex).split('\n').length;
    return Math.abs(lineStart - bareHit.line) <= 12;
  }
  return false;
}

function validateInventory(inventoryPath) {
  const inventory = loadJson(inventoryPath);
  const failures = [];

  for (const file of inventory.inScopeFiles) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) {
      failures.push(`missing in-scope file: ${file}`);
    }
  }

  const helperFile = 'scripts/supervisor-recovery.test-helpers.ts';
  const helperBare = findBareSleeps(helperFile);
  if (helperBare.length !== 1) {
    failures.push(
      `expected exactly one bare setTimeout in ${helperFile} (sleepMs core), found ${helperBare.length}`,
    );
  }

  for (const file of inventory.inScopeFiles) {
    if (file === helperFile) continue;
    const bareHits = findBareSleeps(file).map((hit) => ({ ...hit, file }));
    if (bareHits.length === 0) continue;
    const fileText = readFileSync(join(repoRoot, file), 'utf8');
    for (const hit of bareHits) {
      const covered = inventory.sites.some(
        (site) =>
          site.file === file &&
          (site.classification === 'poll-interval' || site.anchor) &&
          (site.anchor ? fileText.includes(site.anchor) : false),
      );
      if (!covered) {
        failures.push(`unclassified bare setTimeout at ${file}:${hit.line}`);
      }
    }
  }

  for (const site of inventory.sites) {
    const fileText = readFileSync(join(repoRoot, site.file), 'utf8');
    if (!fileText.includes(site.anchor)) {
      failures.push(`inventory anchor missing in ${site.file}: ${site.anchor}`);
      continue;
    }
    if (site.classification === 'negative/quiescence-fixed' && !FIXED_WINDOW_RE.test(fileText)) {
      failures.push(`${site.id}: negative site must use fixedObservationWindow in ${site.file}`);
    }
    if (
      site.classification === 'positive-convertible' &&
      /fixedObservationWindow\s*\(\s*\d+/.test(fileText) &&
      site.anchor.includes('fixedObservationWindow')
    ) {
      failures.push(`${site.id}: quiescence window cannot be classified positive-convertible`);
    }
    if (
      (site.classification === 'positive-convertible' || site.classification === 'teardown-poll') &&
      !POSITIVE_HELPER_RE.test(fileText)
    ) {
      failures.push(`${site.id}: converted site must use shared positive poller in ${site.file}`);
    }
    if (
      (site.classification === 'positive-convertible' || site.classification === 'teardown-poll') &&
      !site.generationBoundary
    ) {
      failures.push(`${site.id}: converted site missing generationBoundary`);
    }
    if (
      site.classification === 'negative/quiescence-fixed' &&
      !site.startSnapshot
    ) {
      failures.push(`${site.id}: negative site missing startSnapshot`);
    }
    if (site.raceFixture) {
      const target = inventory.raceFixtures?.[site.raceFixture];
      if (!target) {
        failures.push(`${site.id}: raceFixture ${site.raceFixture} not mapped`);
      }
    }
  }

  for (const [file, expected] of Object.entries(inventory.assertionFingerprints ?? {})) {
    const actual = hashExpectLines(file);
    if (actual !== expected) {
      failures.push(`assertion fingerprint mismatch for ${file}`);
    }
  }

  const runtime = inventory.runtimeEvidence ?? {};
  for (const [file, baseline] of Object.entries(runtime.mergeBaseP75WallMs ?? {})) {
    const current = runtime.p75WallMs?.[file];
    if (typeof current !== 'number') {
      failures.push(`missing current p75WallMs for ${file}`);
      continue;
    }
    if (!(current < baseline)) {
      failures.push(`p75WallMs for ${file} (${current}) must be lower than merge-base (${baseline})`);
    }
  }

  const raceFixtureTest = join(repoRoot, 'scripts/supervisor-test-wait-race.fixture.test.ts');
  if (!existsSync(raceFixtureTest)) {
    failures.push('missing race/stale-state fixture test');
  } else {
    const raceText = readFileSync(raceFixtureTest, 'utf8');
    for (const family of ['log', 'marker', 'stdout', 'process-exit']) {
      if (!raceText.includes(`${family}-generation-boundary`)) {
        failures.push(`race fixture missing ${family}-generation-boundary coverage`);
      }
    }
  }

  return { inventory, failures };
}

function validateNegativeRegression(negativePath) {
  const { failures } = validateInventory(negativePath);
  if (failures.length === 0) {
    cliFail('negative regression corpus must be rejected but passed validation');
  }
  console.log('[PASS] negative regression corpus rejected as expected');
}

function main() {
  const mode = process.argv[2] ?? 'production';
  const inventoryPath = join(repoRoot, 'scripts/supervisor-test-wait-inventory.json');
  const negativePath = join(
    repoRoot,
    'scripts/fixtures/supervisor-test-wait-negative-regression.json',
  );

  if (mode === 'negative-regression') {
    if (!existsSync(negativePath)) {
      cliFail(`missing negative regression corpus: ${negativePath}`);
    }
    validateNegativeRegression(negativePath);
    return;
  }

  const { failures } = validateInventory(inventoryPath);
  if (failures.length > 0) {
    console.error('[FAIL] supervisor test wait inventory:');
    for (const item of failures) console.error(` - ${item}`);
    process.exit(1);
  }

  try {
    const mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const inventory = loadJson(inventoryPath);
    if (inventory.runtimeEvidence?.mergeBaseSha && inventory.runtimeEvidence.mergeBaseSha !== mergeBase) {
      console.warn(
        `[WARN] inventory mergeBaseSha (${inventory.runtimeEvidence.mergeBaseSha}) differs from current merge-base (${mergeBase}); refresh after rebase`,
      );
    }
  } catch {
    console.warn('[WARN] could not compare merge-base SHA');
  }

  console.log('[PASS] supervisor test wait inventory (classification, positive-poll, negative-preserved, assertion-strength, runtime p75)');
}

main();
