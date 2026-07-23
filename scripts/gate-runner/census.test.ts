import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateCensus,
  loadCensus,
  validateCensusSchema,
  type GateCensus,
} from './census.ts';
import { registeredGateIds } from './runner.ts';
import { captureSourceSnapshot, memorySnapshot } from './source-snapshot.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

function clone(census: GateCensus): GateCensus {
  return JSON.parse(JSON.stringify(census)) as GateCensus;
}

function currentFiles(): Record<string, string> {
  return Object.fromEntries(captureSourceSnapshot(repoRoot).files);
}

describe('terminal gate population census after Issue #906', () => {
  it('reconciles the real cut tree', () => {
    const result = evaluateCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), registeredGateIds);
    expect(result.status, result.details?.join('\n')).toBe('PASS');
  });

  it('partitions every former deferral into a terminal bulk state', () => {
    const census = loadCensus(repoRoot);
    expect(census.version).toBe(2);
    expect(validateCensusSchema(census).join('\n')).toBe('');
    expect(census.entries.some((entry) => entry.classification === 'deferred-to-named-wave')).toBe(false);
    expect(census.entries.filter((entry) => entry.classification === 'retired-in-bulk')).toHaveLength(184);
    expect(census.entries.filter((entry) => entry.classification === 'kept-in-pr1')).toHaveLength(46);
    expect(census.entries.filter((entry) => entry.classification === 'retired-with-reason')).toHaveLength(4);
  });

  it('requires every kept-in-pr1 row to cite C, D, or G', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification === 'kept-in-pr1');
    expect(index).toBeGreaterThanOrEqual(0);
    const entries = [...census.entries];
    const { keepCategory: _removed, ...withoutCategory } = entries[index]!;
    entries[index] = withoutCategory;
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('valid keepCategory');
  });

  it('rejects keep-category leakage onto a retired row', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification === 'retired-in-bulk');
    expect(index).toBeGreaterThanOrEqual(0);
    const entries = [...census.entries];
    entries[index] = { ...entries[index]!, keepCategory: 'G' };
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('only kept-in-pr1 rows may carry keepCategory');
  });

  it('requires every schema-v2 ported row to identify its migration wave', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification.startsWith('ported-'));
    const entries = [...census.entries];
    const { portedInWave: _removed, ...withoutOwner } = entries[index]!;
    entries[index] = withoutOwner;
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('valid portedInWave owner');
  });

  it('binds terminal classifications to the committed ownership digest', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification === 'kept-in-pr1');
    const entries = [...census.entries];
    entries[index] = { ...entries[index]!, classification: 'retired-in-bulk', keepCategory: undefined };
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('migration ownership digest drift');
  });

  it('fails when a retained PowerShell subject disappears', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.classification === 'kept-in-pr1' && entry.sourceKind === 'check-script');
    expect(row).toBeDefined();
    const files = currentFiles();
    delete files[row!.sourcePath];
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain(`${row!.id}: retained legacy gate was dropped`);
  });

  it('fails when a retired PowerShell subject is restored', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.classification === 'retired-in-bulk' && entry.sourceKind === 'check-script');
    expect(row).toBeDefined();
    const files = currentFiles();
    files[row!.sourcePath] = '# restored legacy gate\n';
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain(`${row!.id}: migrated/retired PowerShell gate still exists`);
  });

  it('fails when a retained inline verify member disappears', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.classification === 'kept-in-pr1' && entry.sourceKind === 'verify-inline');
    expect(row).toBeDefined();
    const files = currentFiles();
    files['scripts/verify.ps1'] = (files['scripts/verify.ps1'] ?? '').replaceAll(row!.marker, 'removed-marker');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain(`${row!.id}: retained verify inline aggregation member was dropped`);
  });

  it('fails when a new check script bypasses the frozen population', () => {
    const census = loadCensus(repoRoot);
    const files = currentFiles();
    files['scripts/check-new-hidden-gate.ps1'] = '# new\n';
    expect(evaluateCensus(census, memorySnapshot(files), registeredGateIds).details?.join('\n')).toContain('unaccounted check script');
  });

  it('keeps the real verify aggregator discoverable', () => {
    const verify = readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8');
    expect(verify).toContain('scripts/gate-runner/runner.ts');
  });

  it('fails when a ported gate id is not registered', () => {
    const result = evaluateCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), new Set());
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('registered gate missing');
  });
});
