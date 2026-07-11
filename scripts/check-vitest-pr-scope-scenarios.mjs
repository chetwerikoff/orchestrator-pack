#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLanePlan } from './lib/vitest-ci-lanes.mjs';

const repoRoot = join(import.meta.dirname, '..');
const fixtureRoot = join(repoRoot, 'tests/fixtures/vitest-pr-scope');
const matrix = JSON.parse(readFileSync(join(fixtureRoot, 'scenario-matrix.json'), 'utf8'));
const fixtureBaseSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const fixtureHeadSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'opk-vitest-pr-scope-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'plugins'), { recursive: true });
  cpSync(join(fixtureRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(join(fixtureRoot, 'lanes-config.json'), join(root, 'scripts/vitest-ci-lanes.config.json'));
  cpSync(join(fixtureRoot, 'runtime-history.json'), join(root, 'scripts/vitest-runtime-history.json'));
  return root;
}

function evaluateScenario(root, scenario) {
  const changedFiles = scenario.manifest.entries
    .map((entry) => entry.path)
    .filter((path) => path.endsWith('.test.ts'));
  const result = buildLanePlan(root, {
    changedFiles,
    changedPathManifest: scenario.manifest,
    prScopeMode: 'enforce',
  });
  if (!result.ok) {
    return {
      name: scenario.name,
      ok: false,
      errors: result.errors,
    };
  }
  const actual = {
    className: result.topology.prScope.className,
    effectiveRunMode: result.topology.prScope.effectiveRunMode,
    wouldSelectHeavyFiles: result.topology.prScope.wouldSelectHeavyFiles,
    reason: result.topology.prScope.reason,
  };
  const expected = {
    className: scenario.className,
    effectiveRunMode: scenario.effectiveRunMode,
    wouldSelectHeavyFiles: scenario.wouldSelectHeavyFiles,
    reason: scenario.reason,
  };
  return {
    name: scenario.name,
    ok: actual.className === expected.className
      && actual.effectiveRunMode === expected.effectiveRunMode
      && JSON.stringify(actual.wouldSelectHeavyFiles) === JSON.stringify(expected.wouldSelectHeavyFiles)
      && (expected.reason == null || actual.reason === expected.reason),
    actual,
    expected,
  };
}

const root = makeFixtureRoot();
try {
  const baseline = buildLanePlan(root, { prScopeMode: 'enforce' });
  if (!baseline.ok) {
    throw new Error(`failed to build baseline lane plan: ${baseline.errors.join('; ')}`);
  }
  const fullHeavyFiles = [...baseline.heavy];
  const supplementalCases = [
    {
      name: 'binary-file-low-confidence',
      className: 'source-only',
      effectiveRunMode: 'full',
      wouldSelectHeavyFiles: fullHeavyFiles,
      reason: 'low-confidence-or-unmapped-change',
      manifest: {
        version: 1,
        baseSha: fixtureBaseSha,
        headSha: fixtureHeadSha,
        diffOk: true,
        entryCount: 1,
        entries: [
          {
            status: 'M',
            path: 'scripts/fixture-image.png',
            oldMode: '100644',
            newMode: '100644',
            oldSha: '1111111111111111111111111111111111111111',
            newSha: '2222222222222222222222222222222222222222',
          },
        ],
      },
    },
    {
      name: 'symlink-change-low-confidence',
      className: 'source-only',
      effectiveRunMode: 'full',
      wouldSelectHeavyFiles: fullHeavyFiles,
      reason: 'low-confidence-or-unmapped-change',
      manifest: {
        version: 1,
        baseSha: fixtureBaseSha,
        headSha: fixtureHeadSha,
        diffOk: true,
        entryCount: 1,
        entries: [
          {
            status: 'M',
            path: 'scripts/fixture-link',
            oldMode: '120000',
            newMode: '120000',
            oldSha: '3333333333333333333333333333333333333333',
            newSha: '4444444444444444444444444444444444444444',
          },
        ],
      },
    },
    {
      name: 'submodule-gitlink-low-confidence',
      className: 'source-only',
      effectiveRunMode: 'full',
      wouldSelectHeavyFiles: fullHeavyFiles,
      reason: 'low-confidence-or-unmapped-change',
      manifest: {
        version: 1,
        baseSha: fixtureBaseSha,
        headSha: fixtureHeadSha,
        diffOk: true,
        entryCount: 1,
        entries: [
          {
            status: 'M',
            path: 'scripts/fixture-submodule',
            oldMode: '160000',
            newMode: '160000',
            oldSha: '5555555555555555555555555555555555555555',
            newSha: '6666666666666666666666666666666666666666',
          },
        ],
      },
    },
    {
      name: 'generated-surface-fails-closed',
      className: 'mixed/cross-cutting',
      effectiveRunMode: 'full',
      wouldSelectHeavyFiles: fullHeavyFiles,
      reason: 'generated-or-vendored-surface',
      manifest: {
        version: 1,
        baseSha: fixtureBaseSha,
        headSha: fixtureHeadSha,
        diffOk: true,
        entryCount: 1,
        entries: [
          {
            status: 'M',
            path: 'scripts/generated/fixture-client.ts',
            oldMode: '100644',
            newMode: '100644',
            oldSha: '7777777777777777777777777777777777777777',
            newSha: '8888888888888888888888888888888888888888',
          },
        ],
      },
    },
    {
      name: 'vendored-surface-fails-closed',
      className: 'mixed/cross-cutting',
      effectiveRunMode: 'full',
      wouldSelectHeavyFiles: fullHeavyFiles,
      reason: 'generated-or-vendored-surface',
      manifest: {
        version: 1,
        baseSha: fixtureBaseSha,
        headSha: fixtureHeadSha,
        diffOk: true,
        entryCount: 1,
        entries: [
          {
            status: 'M',
            path: 'vendor/fixture-package/index.js',
            oldMode: '100644',
            newMode: '100644',
            oldSha: '9999999999999999999999999999999999999999',
            newSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      },
    },
  ];
  const cases = [...matrix, ...supplementalCases].map((scenario) => evaluateScenario(root, scenario));

  process.stdout.write(`${JSON.stringify({
    ok: cases.every((entry) => entry.ok),
    issue: 732,
    cases,
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
