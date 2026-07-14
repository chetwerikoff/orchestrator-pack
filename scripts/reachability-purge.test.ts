import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error -- the production audit is a checked-in ESM script without generated declarations.
import { buildManifest as buildManifestRuntime } from './reachability-purge.mjs';

interface ReachabilityManifest {
  graphNodeCount: number;
  deletionManifest: Array<{ reason: string }>;
  suspectEdges: Array<{
    target?: string | null;
    possibleTargets?: string[];
    disposition?: string;
    evidence?: string;
    consumerScope?: string;
  }>;
  unresolvedDynamicForms: Array<{
    source?: string;
    kind?: string;
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
  migrationNotesEntry: { authorized: boolean; presentWithRequiredFields: boolean };
  completionStatus: 'complete' | 'blocked';
  completionBlockers: Array<{ code: string; path: string; evidence: string }>;
}

const buildManifest = buildManifestRuntime as (repoRoot?: string) => Promise<ReachabilityManifest>;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'scripts', 'reachability-purge.manifest.json');
const committedManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReachabilityManifest;
let manifest: ReachabilityManifest;

beforeAll(async () => {
  manifest = await buildManifest(repoRoot);
}, 120_000);

describe('reachability-purge', () => {
  it('keeps the issue #819 manifest as a valid historical snapshot while the live procedure remains deterministic', async () => {
    expect(committedManifest.graphNodeCount).toBeGreaterThan(0);
    expect(committedManifest.deletionManifest.length).toBeGreaterThan(0);
    expect(await buildManifest(repoRoot)).toEqual(manifest);
  }, 120_000);

  it('every suspect edge has an explicit disposition with recorded evidence, and no cross-scope works row lacks proof beyond edge-fired evidence', () => {
    expect(manifest.suspectEdges.length).toBeGreaterThan(0);
    expect(manifest.suspectEdges.every((row) => Boolean(row.disposition && row.evidence))).toBe(true);
    expect(manifest.suspectEdges.filter((row) => !row.target && (!row.possibleTargets || row.possibleTargets.length === 0))).toEqual([]);
    expect(manifest.suspectEdges.filter((row) => row.consumerScope === 'cross-scope' && row.disposition === 'works')).toEqual([]);
    const held = new Set(manifest.heldNodes.map((row) => row.path));
    for (const row of manifest.suspectEdges) {
      if (row.disposition === 'works') continue;
      for (const target of row.possibleTargets ?? []) expect(held.has(target)).toBe(true);
    }
  });

  it('unresolved dynamic invocation forms are inventoried and held, not counted as zero-reachability', () => {
    expect(manifest.unresolvedDynamicForms.length).toBeGreaterThan(0);
    expect(manifest.unresolvedDynamicForms.some((row) => row.foldedIntoZeroReachability)).toBe(false);
    const held = new Set(manifest.heldNodes.map((row) => row.path));
    for (const row of manifest.unresolvedDynamicForms) {
      for (const target of row.possibleTargets ?? []) expect(held.has(target)).toBe(true);
    }
  });

  it('fails closed when current tracked sources add a surviving reference to a deleted file', async () => {
    const deletedPath = ['scripts', 'lib', ['Invoke-ContractEvidenceReverify', 'ps1'].join('.')].join('/');
    const agentsPath = path.join(repoRoot, 'AGENTS.md');
    const original = readFileSync(agentsPath, 'utf8');
    try {
      writeFileSync(agentsPath, `${original}\n${deletedPath}\n`, 'utf8');
      const mutated = await buildManifest(repoRoot);
      expect(
        mutated.unresolvedDynamicForms.some(
          (row) =>
            row.kind === 'live-literal-reference-not-proven-invocation'
            && row.source === 'AGENTS.md'
            && (row.possibleTargets ?? []).includes(deletedPath),
        ),
      ).toBe(true);
      expect(mutated.deletionSetDiffFromFormula.unexpected).toContain(deletedPath);
    } finally {
      writeFileSync(agentsPath, original, 'utf8');
    }
  });

  it('preserves the issue #819 historical deletion formula and superseded-caller record', () => {
    expect(committedManifest.deletionSetDiffFromFormula).toEqual({ missing: [], unexpected: [] });
    expect(committedManifest.deletionManifest.every((row) => ['zero-reachability', 'superseded', 'backup'].includes(row.reason))).toBe(true);
    expect(committedManifest.supersededSurfaceInventory.every((row) => row.disposition.startsWith('held-'))).toBe(true);
  });

  it('KEEP-guard and REWRITE-list tests survive', () => {
    expect(manifest.protectedTestsDeleted).toEqual([]);
    expect(manifest.keepGuardList.length).toBeGreaterThan(0);
    expect(manifest.rewriteList.length).toBeGreaterThan(0);
  });

  it('preserves the historical #819 record that deferred the shim cluster to issue #821', () => {
    expect(committedManifest.retiredShimBlockers.length).toBe(6);
    expect(committedManifest.retiredShimBlockers.every((row) => row.trackedInBase && !row.deletedInCurrentTree)).toBe(true);
    expect(committedManifest.retiredShimBlockers.every((row) => row.reachable || row.held)).toBe(true);
    expect(committedManifest.migrationNotesEntry.authorized).toBe(false);
    expect(committedManifest.migrationNotesEntry.presentWithRequiredFields).toBe(false);
    expect(committedManifest.completionBlockers.every((row) => Boolean(row.code && row.path && row.evidence))).toBe(true);
    expect(committedManifest.completionBlockers.map((row) => row.code)).not.toContain('missing-binding-audit-handoff');
    expect(committedManifest.completionBlockers.map((row) => row.code)).not.toContain('shim-cluster-deleted-despite-live-inbound-edge');
    expect(committedManifest.completionStatus).toBe('complete');
    expect(committedManifest.completionBlockers).toEqual([]);
  });
});
