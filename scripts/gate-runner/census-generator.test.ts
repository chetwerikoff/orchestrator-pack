import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePrechangePopulation, populationDigest } from './census-generator.ts';
import { loadCensus } from './census.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

function prechangeFixtureFromCommittedCensus() {
  const census = loadCensus(repoRoot);
  const paths = census.entries
    .filter((entry) => entry.sourceKind === 'check-script')
    .map((entry) => entry.sourcePath);
  const verifyParts: string[] = [];
  for (const entry of census.entries) {
    if (entry.sourceKind === 'verify-script-member') verifyParts.push(entry.marker);
    if (entry.sourceKind !== 'verify-inline') continue;
    if (entry.id.startsWith('verify-inline:command-version:')) verifyParts.push(`Test-CommandVersion -Command '${entry.marker}'`);
    else if (entry.id.startsWith('verify-inline:contract-marker:')) verifyParts.push(entry.marker);
    else if (entry.id.startsWith('verify-inline:write-check:')) verifyParts.push(`Write-Check '${entry.marker}' 'PASS'`);
  }
  const required = census.entries
    .filter((entry) => entry.id.startsWith('verify-inline:required-file:'))
    .map((entry) => `  '${entry.marker}',`)
    .join('\n');
  verifyParts.push(`$requiredFiles = @(\n${required}\n)\nforeach ($file in $requiredFiles) { Test-RequiredFile $file }`);
  const checkReusable = census.entries
    .filter((entry) => entry.sourceKind === 'check-reusable-behavior')
    .map((entry) => entry.marker)
    .join('\n');
  return { paths, verify: verifyParts.join('\n'), checkReusable };
}

describe('pre-change census generator', () => {
  it('reproduces every committed population identity from a pre-change snapshot', () => {
    const census = loadCensus(repoRoot);
    const generated = generatePrechangePopulation(census.baseCommitSha, prechangeFixtureFromCommittedCensus());
    expect(generated.populationCount).toBe(census.populationCount);
    expect(generated.counts).toEqual(census.counts);
    expect(generated.entries).toEqual(census.entries.map(({ id, sourceKind, sourcePath, marker }) => ({ id, sourceKind, sourcePath, marker })));
    expect(populationDigest(generated.entries)).toBe(census.generation.populationDigest);
  });

  it('fails instead of generating an incomplete reusable-behavior population', () => {
    const census = loadCensus(repoRoot);
    const fixture = prechangeFixtureFromCommittedCensus();
    expect(() => generatePrechangePopulation(census.baseCommitSha, {
      ...fixture,
      checkReusable: fixture.checkReusable.replace('$forbiddenPatterns', ''),
    })).toThrow(/check-reusable behavior is absent/u);
  });

  it('binds the committed artifact to the generator, base commit, and a stable digest', () => {
    const census = loadCensus(repoRoot);
    expect(census.generation.tool).toBe('scripts/gate-runner/census-generator.ts');
    expect(census.generation.baseCommitSha).toBe(census.baseCommitSha);
    expect(census.generation.populationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(populationDigest(census.entries)).toBe(census.generation.populationDigest);
  });
});
