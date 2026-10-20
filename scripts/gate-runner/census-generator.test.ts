import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateCurrentHeadProjection, generatePrechangePopulation, migrationOwnershipDigest, populationDigest, serializeCurrentHeadProjection } from './census-generator.ts';
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
    expect(census.generation.migrationOwnershipDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(migrationOwnershipDigest(census.entries)).toBe(census.generation.migrationOwnershipDigest);
  });

  it('batches exact historical candidate reads while preserving the frozen census output', async () => {
    const traceRoot = mkdtempSync(resolve(tmpdir(), 'opk-2675-git-trace-'));
    const tracePath = resolve(traceRoot, 'git-trace2.jsonl');
    const previousTrace = process.env.GIT_TRACE2_EVENT;
    try {
      process.env.GIT_TRACE2_EVENT = tracePath;
      const projection = await generateCurrentHeadProjection(repoRoot, 'a172e02ddf0a57d4d43d10e16ba59f2b45539bbd');
      const serialized = serializeCurrentHeadProjection(projection);
      expect(projection.measuredHead).toBe('a172e02ddf0a57d4d43d10e16ba59f2b45539bbd');
      expect(projection.populationCount).toBe(283);
      expect(projection.populationDigest).toBe('427a91429a56f7236b67ea076f422263fc8ab31f76255e50c03383b910244ab1');
      expect(serialized.outputDigest).toBe('eb04fa6d61f54001eb2f4d9c4b57c9627107533c9f68f33d97ca43eb597d82a9');
      expect(Buffer.byteLength(serialized.bytes, 'utf8')).toBe(180852);

      // Real Git Trace2 launch records: the previous path-by-path git show
      // generated one process per file (2,778 at the historical candidate).
      const launches = readFileSync(tracePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
        .filter((event) => event.event === 'start');
      expect(launches.length).toBeLessThanOrEqual(6);
      expect(launches.filter((event) => event.argv?.includes('cat-file') && event.argv?.includes('--batch'))).toHaveLength(1);
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previousTrace;
      rmSync(traceRoot, { recursive: true, force: true });
    }
  }, 30_000);

});
