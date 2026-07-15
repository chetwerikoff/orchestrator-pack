import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessRtkKillGate,
  buildRtkInventoryArtifact,
  loadRtkPassthroughPatterns,
  normalizeRtkDiscover,
  RTK_INVENTORY_ARTIFACT_CONTRACT,
} from './rtk-discover-inventory.ts';
import { serializeJsonArtifact, validateJsonValue } from '#opk-kernel/json-artifact';

const repoRoot = join(import.meta.dirname, '..', '..');
const fixtureRoot = join(
  repoRoot,
  'tests/external-output-references/variants/opk-json-producers/rtk-discover-inventory',
);

describe('RTK discover inventory JSON producer', () => {
  it('matches the committed golden byte-for-byte with pinned nondeterminism', () => {
    const discover = validateJsonValue(JSON.parse(readFileSync(join(fixtureRoot, 'discover-input.json'), 'utf8')));
    const inventory = normalizeRtkDiscover(discover, loadRtkPassthroughPatterns(repoRoot));
    const killGate = assessRtkKillGate(inventory.Rows);
    const artifact = buildRtkInventoryArtifact(discover, inventory, killGate, 1_767_225_600_123);
    const actual = serializeJsonArtifact(artifact, RTK_INVENTORY_ARTIFACT_CONTRACT);
    const expected = readFileSync(join(fixtureRoot, 'inventory.json'));
    expect(Buffer.from(actual).equals(expected)).toBe(true);
  });

  it('preserves empty collection and zero-input shapes', () => {
    const discover = validateJsonValue({ sessions_scanned: 0, total_commands: 0, since_days: 7, supported: [], unsupported: [] });
    const inventory = normalizeRtkDiscover(discover, []);
    expect(inventory.Rows).toEqual([]);
    expect(assessRtkKillGate(inventory.Rows)).toEqual({
      MaterialityPercent: 15,
      LowRiskQuantifiedMissedTokens: 0,
      HighRiskAoInvocationCount: 0,
      HighRiskAoTokensPerInvocation: 250,
      HighRiskAoEstimatedMissedTokens: 0,
      HighRiskSharePercent: 0,
      Decision: 'no-go',
    });
  });

  it('fails closed for malformed JSON values instead of silently changing shape', () => {
    expect(() => validateJsonValue({ supported: [Number.POSITIVE_INFINITY] })).toThrow(/finite number/);
  });
});
