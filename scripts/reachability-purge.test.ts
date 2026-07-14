import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error -- the production audit is a checked-in ESM script without generated declarations.
import { buildManifest as buildManifestRuntime } from './reachability-purge.mjs';

interface ReachabilityManifest {
  graphNodeCount: number;
  deletionManifest: Array<{ reason: string }>;
  suspectEdges: Array<{
    disposition?: string;
    evidence?: string;
    consumerScope?: string;
  }>;
  unresolvedDynamicForms: Array<{
    foldedIntoZeroReachability: boolean;
    possibleTargets?: string[];
  }>;
  heldNodes: Array<{ path: string }>;
  deletionSetDiffFromFormula: { missing: string[]; unexpected: string[] };
  supersededSurfaceInventory: Array<{ disposition: string }>;
  protectedTestsDeleted: string[];
  keepGuardList: string[];
  rewriteList: string[];
  retiredShimBlockers: Array<{
    trackedInBase: boolean;
    deletedInCurrentTree: boolean;
    reachable: boolean;
    held: boolean;
  }>;
}

const buildManifest = buildManifestRuntime as (repoRoot?: string) => ReachabilityManifest;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'scripts', 'reachability-purge.manifest.json');
let manifest: ReachabilityManifest;

beforeAll(() => {
  manifest = buildManifest(repoRoot);
}, 120_000);

describe('reachability-purge', () => {
  it('manifest committed, procedure re-runnable, and re-run reproduces the committed manifest with zero drift', () => {
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.graphNodeCount).toBeGreaterThan(0);
    expect(manifest.deletionManifest.length).toBeGreaterThan(0);
    expect(manifest).toEqual(committed);
  });

  it('every suspect edge has an explicit disposition with recorded evidence, and no cross-scope works row lacks proof beyond edge-fired evidence', () => {
    expect(manifest.suspectEdges.length).toBeGreaterThan(0);
    expect(manifest.suspectEdges.every((row) => Boolean(row.disposition && row.evidence))).toBe(true);
    expect(manifest.suspectEdges.filter((row) => row.consumerScope === 'cross-scope' && row.disposition === 'works')).toEqual([]);
  });

  it('unresolved dynamic invocation forms are inventoried and held, not counted as zero-reachability', () => {
    expect(manifest.unresolvedDynamicForms.length).toBeGreaterThan(0);
    expect(manifest.unresolvedDynamicForms.some((row) => row.foldedIntoZeroReachability)).toBe(false);
    const held = new Set(manifest.heldNodes.map((row) => row.path));
    for (const row of manifest.unresolvedDynamicForms) {
      for (const target of row.possibleTargets ?? []) expect(held.has(target)).toBe(true);
    }
  });

  it('deletion set matches deadness formula including superseded-caller resolution', () => {
    expect(manifest.deletionSetDiffFromFormula).toEqual({ missing: [], unexpected: [] });
    expect(manifest.deletionManifest.every((row) => ['zero-reachability', 'superseded', 'backup'].includes(row.reason))).toBe(true);
    expect(manifest.supersededSurfaceInventory.every((row) => row.disposition.startsWith('held-'))).toBe(true);
  });

  it('KEEP-guard and REWRITE-list tests survive', () => {
    expect(manifest.protectedTestsDeleted).toEqual([]);
    expect(manifest.keepGuardList.length).toBeGreaterThan(0);
    expect(manifest.rewriteList.length).toBeGreaterThan(0);
  });

  it('reports required shim-retirement blockers instead of treating live protected surfaces as dead', () => {
    expect(manifest.retiredShimBlockers.length).toBe(6);
    expect(manifest.retiredShimBlockers.every((row) => row.trackedInBase && !row.deletedInCurrentTree)).toBe(true);
    expect(manifest.retiredShimBlockers.every((row) => row.reachable || row.held)).toBe(true);
  });
});
