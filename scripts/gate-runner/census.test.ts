import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateCensus,
  loadCensus,
  validateCensusSchema,
  type GateCensus,
} from './census.ts';
import { evaluateCurrentCensus } from './current-census.ts';
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
  it('reconciles the real cut tree through the current Node migration authority', () => {
    const result = evaluateCurrentCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), registeredGateIds);
    expect(result.status, result.details?.join('\n')).toBe('PASS');
  });

  it('partitions every former deferral into a terminal bulk state', () => {
    const census = loadCensus(repoRoot);
    expect(census.version).toBe(2);
    expect(validateCensusSchema(census).join('\n')).toBe('');
    expect(census.entries.some((entry) => entry.classification === 'deferred-to-named-wave')).toBe(false);
    expect(census.entries.filter((entry) => entry.classification === 'retired-in-bulk')).toHaveLength(186);
    expect(census.entries.filter((entry) => entry.classification === 'kept-in-pr1')).toHaveLength(22);
    expect(census.entries.filter((entry) => entry.classification === 'retired-with-reason')).toHaveLength(28);
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
    const result = evaluateCurrentCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain(`${row!.id}: retained legacy gate was dropped`);
  });

  it('fails when a retired PowerShell subject is restored', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.classification === 'retired-in-bulk' && entry.sourceKind === 'check-script');
    expect(row).toBeDefined();
    const files = currentFiles();
    files[row!.sourcePath] = '# restored legacy gate\n';
    const result = evaluateCurrentCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain(`${row!.id}: migrated/retired PowerShell gate still exists`);
  });

  it('fails when a retained verify behavior loses its executable Node wiring', () => {
    const files = currentFiles();
    files['scripts/verify.ts'] = (files['scripts/verify.ts'] ?? '').replace(
      'const ports = await runNodeVerificationPorts(repoRoot);',
      'const ports = { lines: [], failures: [] };',
    );
    const result = evaluateCurrentCensus(loadCensus(repoRoot), memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain('verify-script:scripts/check-gh-inventory-static.ps1: retained verify invocation was dropped');
  });

  it('fails when the reusable migration loses its executable top-level wiring', () => {
    const files = currentFiles();
    files['scripts/verify.ts'] = (files['scripts/verify.ts'] ?? '').replace(
      'const reusable = await runReusableGuard(repoRoot);',
      'const reusable = { lines: [], failures: [], warnings: [] };',
    );
    const result = evaluateCurrentCensus(loadCensus(repoRoot), memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain('scripts/check-reusable.ps1 behavior surface drifted without a reviewed current-source hash');
  });

  it('fails when top-level verification filters the gate runner and would skip gate-census', () => {
    const files = currentFiles();
    files['scripts/verify.ts'] = (files['scripts/verify.ts'] ?? '').replace(
      'const gateReport = runGateRunner(repoRoot);',
      'const gateReport = runGateRunner(repoRoot, gateRegistrations.map((registration) => registration.gateId));',
    );
    const result = evaluateCurrentCensus(loadCensus(repoRoot), memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain('verify.ps1 must contain exactly one gate-runner dispatch marker; found 0');
  });

  it('fails when a new check script bypasses the frozen population', () => {
    const files = currentFiles();
    files['scripts/check-new-hidden-gate.ps1'] = '# new\n';
    expect(evaluateCurrentCensus(loadCensus(repoRoot), memorySnapshot(files), registeredGateIds).details?.join('\n')).toContain('unaccounted check script');
  });

  it('keeps the real Node verify aggregator discoverable through the PowerShell launcher', () => {
    const verify = readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8');
    expect(verify).toContain('verify.ts');
    expect(verify).not.toContain('scripts/gate-runner/runner.ts');
  });

  it('fails when a ported gate id is not registered', () => {
    const result = evaluateCurrentCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), new Set());
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('registered gate missing');
  });

  it('keeps historical evaluator immutable for pre-Node fixtures', () => {
    expect(evaluateCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), registeredGateIds).status).toBe('FAIL');
  });
});
