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
    expect(contract.regressionAnchors).toEqual(['pr2-scheduler']);
    expect(contract.children.find((entry) => entry.id === 'pr2-scheduler')?.mode).toBe('wired');
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
          runtime: 'node',
          script: 'new-blocking-child.ts',
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
      expect.objectContaining({ childId: 'new-blocking-child', code: 'unaccounted_registry_child' }),
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
    const anchor = contract.children.find((entry) => entry.id === 'pr2-scheduler');
    expect(anchor).toBeDefined();
    if (anchor) anchor.maxExternalCallTimeoutMs = 35_001;

    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract: contract as unknown as FleetLivenessContractDocument,
      sourceLoader,
    });
    const finding = findings.find((entry) => entry.code === 'external_timeout_exceeds_half_stall');
    expect(finding?.childId).toBe('pr2-scheduler');
    expect(finding?.message).toContain('35000ms');
    expect(finding?.message).toContain('marginMs=-1');
    emitProof('heartbeat-interval-bounded');
  });

  it('fails if the mandatory scheduler anchor becomes exempt', () => {
    const contract = clone(loadContract()) as unknown as {
      schemaVersion: number;
      regressionAnchors: string[];
      sharedTransports: Record<string, string>;
      children: Array<Record<string, unknown>>;
    };
    const scheduler = contract.children.find((entry) => entry.id === 'pr2-scheduler');
    expect(scheduler).toBeDefined();
    if (scheduler) {
      scheduler.mode = 'exempt';
      scheduler.exemptionReason = 'This intentionally long reason still cannot exempt the mandatory scheduler.';
    }

    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract: contract as unknown as FleetLivenessContractDocument,
      sourceLoader,
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ childId: 'pr2-scheduler', code: 'regression_anchor_exempt' }),
      expect.objectContaining({ childId: 'pr2-scheduler', code: 'regression_anchor_not_wired' }),
    ]));
  });

  it('fails when the scheduler loses its explicit external-call timeout', () => {
    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract: loadContract(),
      sourceLoader: (repoRelativePath) => {
        if (repoRelativePath === 'scripts/pr2-foundation/scheduler.ts') {
          return 'const runProcess = true;';
        }
        return sourceLoader(repoRelativePath);
      },
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ childId: 'pr2-scheduler', code: 'external_timeout_not_wired' }),
    ]));
  });

  it('fails when terminal outcomes bypass crash/backoff accounting', () => {
    const contract = loadContract();
    const terminalPath = contract.sharedTransports.terminalOutcome;
    const findings = validateFleetLivenessCensus({
      repoRoot,
      registry: loadRegistry(),
      contract,
      sourceLoader: (repoRelativePath) => {
        if (repoRelativePath === terminalPath) return 'export const unbounded = true;';
        return sourceLoader(repoRelativePath);
      },
    });
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ childId: '<fleet>', code: 'shared_transport_not_wired' }),
    ]));
  });
});
