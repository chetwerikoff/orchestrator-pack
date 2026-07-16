import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  validateFleetLivenessCensus,
  type SideProcessRegistryDocument,
} from './gate-runner/fleet-liveness-census.ts';
import {
  loadFleetLivenessContract,
  type FleetLivenessContractDocument,
} from './kernel/side-process-liveness.ts';

const repoRoot = process.cwd();

function loadRegistry(): SideProcessRegistryDocument {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'scripts/orchestrator-side-process-registry.json'), 'utf8'),
  ) as SideProcessRegistryDocument;
}

function loadContract(): FleetLivenessContractDocument {
  return loadFleetLivenessContract(
    path.join(repoRoot, 'scripts/orchestrator-side-process-liveness-contract.json'),
  );
}

function sourceLoader(repoRelativePath: string): string | null {
  const absolute = path.join(repoRoot, repoRelativePath);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emitProof(expected: string): void {
  console.log(JSON.stringify({
    producer: 'orchestrator-pack',
    datum: 'fleet-liveness-coverage',
    expected,
  }));
}

describe('fleet-liveness-census', () => {
  it('expected: regression-anchors-wired', () => {
    expect(validateFleetLivenessCensus({ repoRoot })).toEqual([]);
    const contract = loadContract();
    for (const childId of [
      'review-ready-report-state-seed',
      'review-trigger-reeval',
    ]) {
      expect(contract.regressionAnchors).toContain(childId);
      expect(contract.children.find((entry) => entry.id === childId)?.mode).toBe('wired');
    }
    emitProof('regression-anchors-wired');
  });

  it('expected: class-coverage-drift', () => {
    const registry = clone(loadRegistry());
    const mutated: SideProcessRegistryDocument = {
      ...registry,
      requiredChildIds: [...registry.requiredChildIds, 'new-blocking-child'],
      children: [
        ...registry.children,
        {
          id: 'new-blocking-child',
          script: 'new-blocking-child.ps1',
          cadenceSeconds: 5,
          stallGraceMultiplier: 4,
        },
      ],
    };
    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: mutated,
      contract: loadContract(),
      sourceLoader,
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        childId: 'new-blocking-child',
        code: 'unaccounted_registry_child',
      }),
    ]));
    emitProof('class-coverage-drift');
  });

  it('expected: heartbeat-interval-bounded', () => {
    expect(validateFleetLivenessCensus({ repoRoot })).toEqual([]);
    const contract = clone(loadContract()) as unknown as {
      schemaVersion: number;
      regressionAnchors: string[];
      sharedTransports: Record<string, string>;
      children: Array<Record<string, unknown>>;
    };
    const anchor = contract.children.find((entry) => entry.id === 'review-trigger-reeval');
    expect(anchor).toBeDefined();
    if (anchor) anchor.maxExternalCallTimeoutMs = 10_001;

    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract: contract as unknown as FleetLivenessContractDocument,
      sourceLoader,
    });
    const finding = findings.find((entry) => entry.code === 'external_timeout_exceeds_half_stall');
    expect(finding?.childId).toBe('review-trigger-reeval');
    expect(finding?.message).toContain('10000ms');
    expect(finding?.message).toContain('marginMs=-1');
    emitProof('heartbeat-interval-bounded');
  });

  it('fails if either mandatory regression anchor becomes exempt', () => {
    const contract = clone(loadContract()) as unknown as {
      schemaVersion: number;
      regressionAnchors: string[];
      sharedTransports: Record<string, string>;
      children: Array<Record<string, unknown>>;
    };
    const seed = contract.children.find((entry) => entry.id === 'review-ready-report-state-seed');
    expect(seed).toBeDefined();
    if (seed) {
      seed.mode = 'exempt';
      seed.exemptionReason = 'This intentionally long reason still cannot exempt a mandatory anchor.';
    }

    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract: contract as unknown as FleetLivenessContractDocument,
      sourceLoader,
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ childId: 'review-ready-report-state-seed', code: 'regression_anchor_exempt' }),
      expect.objectContaining({ childId: 'review-ready-report-state-seed', code: 'regression_anchor_not_wired' }),
    ]));
  });

  it('fails when a wired child stops reporting terminal outcomes through the shared helper', () => {
    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract: loadContract(),
      sourceLoader: (repoRelativePath) => {
        if (repoRelativePath === 'scripts/review-trigger-reeval.ps1') {
          return '# no terminal helpers';
        }
        return sourceLoader(repoRelativePath);
      },
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        childId: 'review-trigger-reeval',
        code: 'terminal_helper_missing',
      }),
    ]));
  });

  it('fails when a shared gh/ao transport bypasses the TS runtime', () => {
    const contract = loadContract();
    const ghPath = contract.sharedTransports.gh;
    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract,
      sourceLoader: (repoRelativePath) => {
        if (repoRelativePath === ghPath) return '#!/usr/bin/env bash\nexec gh "$@"\n';
        return sourceLoader(repoRelativePath);
      },
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ childId: '<fleet>', code: 'shared_transport_not_wired' }),
    ]));
  });
});
