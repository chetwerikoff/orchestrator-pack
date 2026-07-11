#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLanePlan } from './lib/vitest-ci-lanes.mjs';

const repoRoot = join(import.meta.dirname, '..');
const fixtureRoot = join(repoRoot, 'tests/fixtures/vitest-pr-scope');
const matrix = JSON.parse(readFileSync(join(fixtureRoot, 'scenario-matrix.json'), 'utf8'));

function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'opk-vitest-pr-scope-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'plugins'), { recursive: true });
  cpSync(join(fixtureRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(join(fixtureRoot, 'lanes-config.json'), join(root, 'scripts/vitest-ci-lanes.config.json'));
  cpSync(join(fixtureRoot, 'runtime-history.json'), join(root, 'scripts/vitest-runtime-history.json'));
  return root;
}

const root = makeFixtureRoot();
try {
  const cases = matrix.map((scenario) => {
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
    return {
      name: scenario.name,
      ok: result.topology.prScope.className === scenario.className
        && result.topology.prScope.effectiveRunMode === scenario.effectiveRunMode
        && JSON.stringify(result.topology.prScope.wouldSelectHeavyFiles) === JSON.stringify(scenario.wouldSelectHeavyFiles),
      actual: {
        className: result.topology.prScope.className,
        effectiveRunMode: result.topology.prScope.effectiveRunMode,
        wouldSelectHeavyFiles: result.topology.prScope.wouldSelectHeavyFiles,
      },
      expected: {
        className: scenario.className,
        effectiveRunMode: scenario.effectiveRunMode,
        wouldSelectHeavyFiles: scenario.wouldSelectHeavyFiles,
      },
    };
  });

  process.stdout.write(`${JSON.stringify({
    ok: cases.every((entry) => entry.ok),
    issue: 732,
    cases,
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
