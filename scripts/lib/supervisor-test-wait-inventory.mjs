#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

import { cliFail, loadJsonFile } from './cli-guard-helpers.mjs';

const BARE_SLEEP_RE =
  /new\s+Promise\s*\(\s*(?:\((\w+)\)|(\w+))\s*=>\s*(?:\{[^}]{0,120}setTimeout|setTimeout)\s*\(\s*(?:\1|\2)\b/;
const FIXED_WINDOW_RE = /fixedObservationWindow\s*\(/;
const POLLER_ANCHOR_WINDOW_LINES = 12;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anchorLineNumber(fileText, anchor) {
  if (!fileText.includes(anchor)) return null;
  return fileText.slice(0, fileText.indexOf(anchor)).split('\n').length;
}

function siteCoversBareSleep(site, bareHit, fileText) {
  if (site.file !== bareHit.file) return false;
  if (!site.anchor || !fileText.includes(site.anchor)) return false;
  const anchorLine = anchorLineNumber(fileText, site.anchor);
  if (anchorLine === null) return false;
  return Math.abs(anchorLine - bareHit.line) <= POLLER_ANCHOR_WINDOW_LINES;
}

function siteCoversApprovedPoller(site, fileText, approvedHelpers) {
  const anchorLine = anchorLineNumber(fileText, site.anchor);
  if (anchorLine === null) return false;
  const lines = fileText.split('\n');
  const start = Math.max(0, anchorLine - 1);
  const end = Math.min(lines.length, anchorLine - 1 + POLLER_ANCHOR_WINDOW_LINES);
  const windowText = lines.slice(start, end).join('\n');
  return approvedHelpers.some((helper) => new RegExp(`\\b${escapeRegExp(helper)}\\b`).test(windowText));
}

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

function loadCurrentRuntimeWeights() {
  const historyPath = join(repoRoot, 'scripts/vitest-runtime-history.json');
  if (!existsSync(historyPath)) {
    return null;
  }
  const history = loadJson(historyPath);
  return history.files ?? {};
}

function resolveMergeBaseSha(repoRootOverride = repoRoot) {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: repoRootOverride,
      encoding: 'utf8',
    }).trim();
  } catch {
    try {
      return execFileSync('git', ['merge-base', 'HEAD', 'main'], {
        cwd: repoRootOverride,
        encoding: 'utf8',
      }).trim();
    } catch {
      return null;
    }
  }
}

function shouldEnforceRuntimeImprovement(repoRootOverride = repoRoot) {
  const mergeBaseSha = resolveMergeBaseSha(repoRootOverride);
  if (!mergeBaseSha) {
    return false;
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRootOverride,
      encoding: 'utf8',
    }).trim();
    return mergeBaseSha !== head;
  } catch {
    return false;
  }
}

function loadMergeBaseRuntimeWeights(mergeBaseSha) {
  try {
    const raw = execFileSync('git', ['show', `${mergeBaseSha}:scripts/vitest-runtime-history.json`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const history = JSON.parse(raw);
    return history.files ?? {};
  } catch {
    return null;
  }
}

function runtimeHistoryChangedSinceMergeBase(mergeBaseSha) {
  try {
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', mergeBaseSha, 'HEAD', '--', 'scripts/vitest-runtime-history.json'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    return changed.length > 0;
  } catch {
    return true;
  }
}

function isMisclassifiedQuiescenceSite(site) {
  return (
    site.classification === 'positive-convertible' &&
    typeof site.anchor === 'string' &&
    site.anchor.includes('fixedObservationWindow')
  );
}

function validateInventory(inventoryPath, options = {}) {
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
      const covered = inventory.sites.some((site) => siteCoversBareSleep(site, hit, fileText));
      if (!covered) {
        failures.push(`unclassified bare setTimeout at ${file}:${hit.line}`);
      }
    }
  }

  const approvedHelpers = inventory.approvedPositiveHelpers ?? [];
  if (approvedHelpers.length === 0) {
    failures.push('approvedPositiveHelpers is required');
  }

  for (const site of inventory.sites) {
    const fileText = readFileSync(join(repoRoot, site.file), 'utf8');
    if (!fileText.includes(site.anchor)) {
      failures.push(`inventory anchor missing in ${site.file}: ${site.anchor}`);
      continue;
    }
    if (isMisclassifiedQuiescenceSite(site)) {
      failures.push(`${site.id}: quiescence window cannot be classified positive-convertible`);
      continue;
    }
    if (site.classification === 'negative/quiescence-fixed' && !FIXED_WINDOW_RE.test(fileText)) {
      failures.push(`${site.id}: negative site must use fixedObservationWindow in ${site.file}`);
    }
    if (
      (site.classification === 'positive-convertible' || site.classification === 'teardown-poll') &&
      !siteCoversApprovedPoller(site, fileText, approvedHelpers)
    ) {
      failures.push(
        `${site.id}: converted site must use an approved positive poller at anchor in ${site.file}`,
      );
    }
    if (
      (site.classification === 'positive-convertible' || site.classification === 'teardown-poll') &&
      !site.generationBoundary
    ) {
      failures.push(`${site.id}: converted site missing generationBoundary`);
    }
    if (
      (site.classification === 'positive-convertible' || site.classification === 'teardown-poll') &&
      site.generationBoundary &&
      !site.raceFixture
    ) {
      failures.push(`${site.id}: converted site missing raceFixture generation-boundary coverage`);
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

  if (!options.skipRuntimeEvidence) {
    const runtime = inventory.runtimeEvidence ?? {};
    const trackedFiles = runtime.trackedFiles ?? [];
    if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) {
      failures.push('runtimeEvidence.trackedFiles must list files checked against vitest-runtime-history.json');
    } else if (shouldEnforceRuntimeImprovement()) {
      const mergeBaseSha = resolveMergeBaseSha();
      if (!mergeBaseSha) {
        failures.push('could not resolve merge-base SHA for runtime weight binding');
      } else if (runtime.enforceImprovementInThisChange === false) {
        if (!String(runtime.externalOwner ?? '').trim()) {
          failures.push('runtimeEvidence.externalOwner is required when improvement is externally owned');
        }
        if (runtimeHistoryChangedSinceMergeBase(mergeBaseSha)) {
          failures.push(
            'scripts/vitest-runtime-history.json changed despite external runtime-history ownership',
          );
        }
      } else {
        const mergeBaseWeights = loadMergeBaseRuntimeWeights(mergeBaseSha);
        const currentWeights = loadCurrentRuntimeWeights();
        if (!mergeBaseWeights) {
          failures.push(`could not load vitest-runtime-history.json at merge-base ${mergeBaseSha}`);
        } else if (!currentWeights) {
          failures.push('missing current scripts/vitest-runtime-history.json');
        } else {
          for (const file of trackedFiles) {
            const current = currentWeights[file];
            const baseline = mergeBaseWeights[file];
            if (typeof current !== 'number') {
              failures.push(`missing current vitest-runtime-history weight for ${file}`);
              continue;
            }
            if (typeof baseline !== 'number') {
              failures.push(`missing merge-base vitest-runtime-history weight for ${file}`);
              continue;
            }
            if (!(current < baseline)) {
              failures.push(
                `vitest-runtime-history weight for ${file} (${current}) must be lower than merge-base (${baseline})`,
              );
            }
          }
        }
      }
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
  const { failures } = validateInventory(negativePath, { skipRuntimeEvidence: true });
  if (failures.length === 0) {
    cliFail('negative regression corpus must be rejected but passed validation');
  }
  const misclassificationFailures = failures.filter((item) =>
    item.includes('quiescence window cannot be classified positive-convertible'),
  );
  if (misclassificationFailures.length !== 1 || failures.length !== 1) {
    cliFail(
      `negative regression corpus must fail only for misclassification; got ${failures.length} failure(s): ${failures.join('; ')}`,
    );
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

  console.log('[PASS] supervisor test wait inventory (classification, positive-poll, negative-preserved, assertion-strength, runtime ownership)');
}

main();
