// @vitest-ci-lane light
// @vitest-pre-topology-seconds 1
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHistoricalDispositionPaths, scanRetiredRuntimeSurfaces } from './retired-surface-guard.ts';

const roots: string[] = [];
const canonicalPatterns = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../json-producers/retired-runtime-surfaces.json'),
  'utf8',
);
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(text: string, path = 'scripts/active.ts'): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-retirement-'));
  roots.push(root);
  const patterns = join(root, 'scripts/json-producers/retired-runtime-surfaces.json');
  mkdirSync(dirname(patterns), { recursive: true });
  writeFileSync(patterns, canonicalPatterns);
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return root;
}

describe('runtime retirement closed-world scanner', () => {
  it('accepts neutral active code', () => {
    expect(scanRetiredRuntimeSurfaces({ repoRoot: fixture('pack review list') }).violations).toEqual([]);
  });

  it('keeps exact source identities case-sensitive', () => {
    const root = fixture('const status = "orca_smoke_control_plane_codes";\nAO STATUS is descriptive prose');
    expect(scanRetiredRuntimeSurfaces({ repoRoot: root }).violations).toEqual([]);
  });

  it.each([
    ['env authority', 'const value = process.env.AO_SESSION_ID;', 'scripts/active.ts', 'legacy-runtime-selector'],
    ['status command', 'ao status --json', 'scripts/active.ts', 'legacy-runtime-command'],
    ['spawn command', 'ao spawn worker --json', 'scripts/active.ts', 'legacy-runtime-command'],
    ['orchestrator command', 'ao orchestrator ls --json', 'scripts/active.ts', 'legacy-runtime-command'],
    ['top-level option', 'ao --version', 'scripts/active.ts', 'legacy-runtime-command'],
    ['active markdown prescription', 'Run `ao start --json` before continuing.', 'docs/runbook.md', 'legacy-runtime-command'],
    ['daemon route', 'fetch("http://localhost:3000/api/v1/sessions/current")', 'scripts/active.ts', 'legacy-daemon-http'],
    ['legacy package', 'import "@orchestrator-pack/ao-scope-guard";', 'scripts/active.ts', 'legacy-plugin-identity'],
    ['legacy bin', 'const cmd = "ao-codex-review";', 'scripts/active.ts', 'legacy-plugin-identity'],
    ['legacy plugin path', 'neutral', 'plugins/ao-scope-guard/README.md', 'legacy-plugin-identity'],
    ['legacy config', 'const config = "agent-orchestrator.yaml";', 'scripts/active.ts', 'legacy-config-state-root'],
    ['legacy state root', 'const state = ".ao/state.json";', 'scripts/active.ts', 'legacy-config-state-root'],
    ['compatibility alias', 'const alias = "OPK_REAL_RUNTIME";', 'scripts/active.ts', 'compatibility-alias'],
    ['named adapter shim', 'function Install-AoLivenessShim {}', 'scripts/active.ts', 'legacy-adapter-symbol'],
    ['global command shim', 'function global:ao { "retired" }', 'scripts/active.ts', 'legacy-adapter-symbol'],
    ['retired script path', 'neutral', 'scripts/ao-review.ts', 'legacy-runtime-command'],
  ])('rejects injected %s surface', (_name, text, path, surfaceId) => {
    const result = scanRetiredRuntimeSurfaces({ repoRoot: fixture(text, path) });
    expect(result.violations.some((entry) => entry.surfaceId === surfaceId)).toBe(true);
  });

  it('excludes immutable history but not active fixtures', () => {
    const root = fixture('neutral');
    const historical = join(root, 'docs/issues_drafts/old.md');
    mkdirSync(dirname(historical), { recursive: true });
    writeFileSync(historical, 'AO_SESSION_ID');
    const frozenGate = join(root, 'scripts/gate-runner/census/pre-change-baseline.json');
    mkdirSync(dirname(frozenGate), { recursive: true });
    writeFileSync(frozenGate, 'AO_SESSION_ID');
    const activeFixture = join(root, 'scripts/fixtures/current.txt');
    mkdirSync(dirname(activeFixture), { recursive: true });
    writeFileSync(activeFixture, 'AO_SESSION_ID');
    const result = scanRetiredRuntimeSurfaces({ repoRoot: root, paths: [
      'scripts/active.ts',
      'docs/issues_drafts/old.md',
      'scripts/gate-runner/census/pre-change-baseline.json',
      'scripts/fixtures/current.txt',
    ] });
    expect(result.excludedPaths).toContain('docs/issues_drafts/old.md');
    expect(result.excludedPaths).toContain('scripts/gate-runner/census/pre-change-baseline.json');
    expect(result.violations.map((entry) => entry.path)).toContain('scripts/fixtures/current.txt');
  });

  it('honors only exact per-file historical dispositions', () => {
    const root = fixture('neutral');
    const manifest = join(root, 'docs/investigations/runtime-hard-cut/historical-dispositions.json');
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      dispositions: [{
        path: 'docs/frozen-contract.mjs',
        class: 'precut-behavioral-contract',
        reason: 'frozen evidence',
        owningReference: 'Issue #1352',
      }],
    }));
    const frozen = join(root, 'docs/frozen-contract.mjs');
    writeFileSync(frozen, 'AO_SESSION_ID');
    const sibling = join(root, 'docs/current-contract.mjs');
    writeFileSync(sibling, 'AO_SESSION_ID');

    expect([...loadHistoricalDispositionPaths(root)]).toEqual(['docs/frozen-contract.mjs']);
    const result = scanRetiredRuntimeSurfaces({ repoRoot: root, paths: [
      'docs/frozen-contract.mjs',
      'docs/current-contract.mjs',
    ] });
    expect(result.excludedPaths).toEqual(['docs/frozen-contract.mjs']);
    expect(result.violations.map((entry) => entry.path)).toEqual(['docs/current-contract.mjs']);
  });

  it('rejects wildcard historical dispositions', () => {
    const root = fixture('neutral');
    const manifest = join(root, 'docs/investigations/runtime-hard-cut/historical-dispositions.json');
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      dispositions: [{
        path: 'docs/*.mjs',
        class: 'precut-behavioral-contract',
        reason: 'too broad',
        owningReference: 'Issue #1352',
      }],
    }));
    expect(() => loadHistoricalDispositionPaths(root)).toThrow(/exact file/);
  });
});
