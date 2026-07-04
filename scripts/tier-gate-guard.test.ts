import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkTierGateGuard,
  checkWorkerSafetyFloor,
  FLOOR_CHECKS,
  selectAuthoringReviewStages,
} from './lib/tier-gate-core.js';
import { runCli } from './tier-gate-guard.js';
import { screenRedFlagMarkers } from './lib/tier-marker-screen.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/tier-gate',
);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadFixture(name: string) {
  return readFileSync(path.join(fixturesDir, `${name}.md`), 'utf8');
}

function fixturePath(name: string) {
  return path.join(fixturesDir, `${name}.md`);
}

describe('tier-gate guard fails a red-flag-marked task assigned below T3 and passes a marker-free task on its lower tier', () => {
  it('fails when a red-flag marker phrase coincides with a T1 fence', () => {
    const text = loadFixture('marker-hit-sub-t3-brief');
    const result = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('marker-hit-sub-t3-brief'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/below T3|ci-review-gating/);
    expect(screenRedFlagMarkers(text).hits).toContain('ci-review-gating');
  });

  it('passes a marker-free T1 brief with required worker-safety floor', () => {
    const text = loadFixture('marker-free-t1-brief');
    const result = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('marker-free-t1-brief'),
    });
    expect(result.ok).toBe(true);
    expect(result.receipt?.kind).toBe('tier-fence');
    if (result.receipt?.kind === 'tier-fence') {
      expect(result.receipt.tier).toBe('T1');
    }
  });

  it('fails when design/adversarial stages are skipped on a marked brief', () => {
    const text = loadFixture('marker-hit-sub-t3-brief');
    const result = checkTierGateGuard(text, {
      tier: 'T3',
      designSkipped: true,
      adversarialSkipped: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/design-analysis|adversarial/);
  });

  it('passes skip-line input after marker screen is clean', () => {
    const text = loadFixture('skip-line-brief');
    const result = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('skip-line-brief'),
    });
    expect(result.ok).toBe(true);
    expect(result.receipt?.kind).toBe('no-tier');
  });

  it('exits non-zero on CLI for marker+sub-T3 fixture', () => {
    const fixtureFile = path.join(fixturesDir, 'marker-hit-sub-t3-brief.md');
    expect(
      runCli(['node', 'tier-gate-guard.ts', '--text-file', fixtureFile, '--repo-root', repoRoot, '--draft-path', fixtureFile]),
    ).toBe(1);
  });

  it('exits zero on CLI for marker-free T1 fixture', () => {
    const fixtureFile = path.join(fixturesDir, 'marker-free-t1-brief.md');
    expect(
      runCli(['node', 'tier-gate-guard.ts', '--text-file', fixtureFile, '--repo-root', repoRoot, '--draft-path', fixtureFile]),
    ).toBe(0);
  });
});

describe('floor on every tier', () => {
  it('includes all never-skipped floor checks on a T1-tier fixture run', () => {
    const text = loadFixture('marker-free-t1-brief');
    const stages = selectAuthoringReviewStages({ tier: 'T1', skipLine: false });
    expect(stages.floor).toEqual(FLOOR_CHECKS);
    expect(stages.authoring).toEqual([]);
    expect(stages.review).toEqual(['light-architectural']);
  });

  it('fails when a T1 draft is missing allowed-roots/denylist worker-safety fences', () => {
    const text = loadFixture('t1-missing-floor-brief');
    const floor = checkWorkerSafetyFloor(text);
    expect(floor.ok).toBe(false);
    const gate = checkTierGateGuard(text, { repoRoot, draftPath: fixturePath('t1-missing-floor-brief') });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/denylist|allowed-roots|Verification/);
  });

  it('fails when a T1 draft is missing behavior-kind floor', () => {
    const text = loadFixture('t1-missing-behavior-kind-brief');
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('t1-missing-behavior-kind-brief'),
    });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/behavior-kind/);
  });

  it('fails when a T1 draft is missing contract-evidence floor', () => {
    const text = loadFixture('t1-missing-contract-evidence-brief');
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('t1-missing-contract-evidence-brief'),
    });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/contract-evidence/);
  });

  it('fails when a draft has denylist but no allowed-roots fence', () => {
    const text = loadFixture('denylist-only-missing-allowed-roots-brief');
    const floor = checkWorkerSafetyFloor(text);
    expect(floor.ok).toBe(false);
    expect(floor.errors.join(' ')).toMatch(/allowed-roots/);
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('denylist-only-missing-allowed-roots-brief'),
    });
    expect(gate.ok).toBe(false);
  });

  it('wrapper-invoked T1 recompute selects a path at least T2 with adversarial stage', () => {
    const text = loadFixture('marker-free-t1-brief');
    const stages = selectAuthoringReviewStages({
      tier: 'T1',
      skipLine: false,
      explicitAdversarialWrapper: true,
    });
    expect(stages.effectiveTier).toBe('T2');
    expect(stages.review).toContain('competitive-adversarial');
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('marker-free-t1-brief'),
      explicitAdversarialWrapper: true,
    });
    expect(gate.ok).toBe(true);
    if (gate.receipt?.kind === 'tier-fence') {
      expect(gate.receipt.wrapperFloorApplied).toBe(true);
    }
  });
});
