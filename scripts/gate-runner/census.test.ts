import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_WAVES,
  discoverVerifyInlineIds,
  evaluateCensus,
  loadCensus,
  validateCensusSchema,
  type GateCensus,
} from './census.ts';
import { registeredGateIds } from './runner.ts';
import { captureSourceSnapshot, memorySnapshot } from './source-snapshot.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

function escapeRegExpLiteral(text: string): string {
  const metacharacters = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);
  return [...text].map((character) => metacharacters.has(character) ? `\\${character}` : character).join('');
}

function clone(census: GateCensus): GateCensus {
  return JSON.parse(JSON.stringify(census)) as GateCensus;
}

describe('frozen gate population census', () => {
  it('reconciles the real final tree', () => {
    const result = evaluateCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), registeredGateIds);
    expect(result.status, result.details?.join('\n')).toBe('PASS');
  });

  it('commits the terminal Wave 3.b taxonomy with named deferral owners only', () => {
    const census = loadCensus(repoRoot);
    expect(census.version).toBe(2);
    expect(census.wave).toBe('3.b');
    expect(census.migrationIssue).toBe(841);
    expect(validateCensusSchema(census).join('\n')).toBe('');
    expect(census.entries.some((entry) => entry.classification === 'still-enforced-by-legacy')).toBe(false);
    expect(census.entries.some((entry) => entry.classification === 'retired-with-justification')).toBe(false);
    const owners = new Set(census.entries
      .filter((entry) => entry.classification === 'deferred-to-named-wave')
      .map((entry) => entry.deferredWave));
    expect([...owners].sort()).toEqual([...DEFERRED_WAVES].sort());
  });


  it('requires every schema v2 ported row to identify its migration wave', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification.startsWith('ported-'));
    const entries = [...census.entries];
    const { portedInWave: _removed, ...withoutOwner } = entries[index]!;
    entries[index] = withoutOwner;
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('valid portedInWave owner');
  });

  it('rejects unnamed/invalid deferrals, provisional rows, and terminal-field leakage', () => {
    const census = clone(loadCensus(repoRoot));
    const deferredIndex = census.entries.findIndex((entry) => entry.classification === 'deferred-to-named-wave');
    const portedIndex = census.entries.findIndex((entry) => entry.classification === 'ported-declarative');
    expect(deferredIndex).toBeGreaterThanOrEqual(0);
    expect(portedIndex).toBeGreaterThanOrEqual(0);

    const unnamedEntries = [...census.entries];
    const { deferredWave: _removed, ...unnamed } = unnamedEntries[deferredIndex]!;
    unnamedEntries[deferredIndex] = unnamed;
    expect(validateCensusSchema({ ...census, entries: unnamedEntries }).join('\n')).toContain('valid named sibling wave');

    const invalidOwnerEntries = [...census.entries];
    invalidOwnerEntries[deferredIndex] = { ...invalidOwnerEntries[deferredIndex]!, deferredWave: 'Wave Z' as never };
    expect(validateCensusSchema({ ...census, entries: invalidOwnerEntries }).join('\n')).toContain('valid named sibling wave');

    const provisionalEntries = [...census.entries];
    provisionalEntries[deferredIndex] = {
      ...provisionalEntries[deferredIndex]!,
      classification: 'still-enforced-by-legacy',
      deferredWave: undefined,
    };
    expect(validateCensusSchema({ ...census, entries: provisionalEntries }).join('\n')).toContain('cannot retain provisional classification');

    const nonPortedGateEntries = [...census.entries];
    nonPortedGateEntries[deferredIndex] = { ...nonPortedGateEntries[deferredIndex]!, gateIds: ['ghost-gate'] };
    expect(validateCensusSchema({ ...census, entries: nonPortedGateEntries }).join('\n')).toContain('non-ported row cannot be admitted');

    const portedWithLegacyEntries = [...census.entries];
    portedWithLegacyEntries[portedIndex] = {
      ...portedWithLegacyEntries[portedIndex]!,
      legacyReference: { path: 'scripts/verify.ps1', marker: 'legacy marker', kind: 'verify-script-call' },
    };
    expect(validateCensusSchema({ ...census, entries: portedWithLegacyEntries }).join('\n')).toContain('non-deferred row must not retain');

    const invalidReferenceKindEntries = [...census.entries];
    invalidReferenceKindEntries[deferredIndex] = {
      ...invalidReferenceKindEntries[deferredIndex]!,
      legacyReference: {
        ...invalidReferenceKindEntries[deferredIndex]!.legacyReference!,
        kind: 'substring-only' as never,
      },
    };
    expect(validateCensusSchema({ ...census, entries: invalidReferenceKindEntries }).join('\n')).toContain('invalid legacy reference kind');

    const portedWithOwnerEntries = [...census.entries];
    portedWithOwnerEntries[portedIndex] = { ...portedWithOwnerEntries[portedIndex]!, deferredWave: 'PR 9 workflow sweep' };
    expect(validateCensusSchema({ ...census, entries: portedWithOwnerEntries }).join('\n')).toContain('non-deferred row must not claim');
  });

  it('fails on an unaccounted baseline row or committed count drift', () => {
    const census = clone(loadCensus(repoRoot)) as GateCensus & { entries: GateCensus['entries'] };
    const altered = { ...census, entries: census.entries.slice(1) } as GateCensus;
    expect(validateCensusSchema(altered).join('\n')).toContain('populationCount');
  });

  it('fails when a new check-reusable behavior is appended without a census row', () => {
    const census = loadCensus(repoRoot);
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/check-reusable.ps1'] = `${files['scripts/check-reusable.ps1'] ?? ''}\nif ($env:OPK_HIDDEN_POLICY) { throw 'new hidden enforcement behavior' }\n`;
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('check-reusable.ps1 behavior surface drifted without census reclassification');
  });

  it('fails when a deferred check-reusable behavior disappears', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.classification === 'deferred-to-named-wave' && entry.sourceKind === 'check-reusable-behavior');
    expect(row).toBeDefined();
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/check-reusable.ps1'] = (files['scripts/check-reusable.ps1'] ?? '').replaceAll(row!.marker, 'marker removed');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain(`${row!.id}: typed legacy invocation is no longer executable`);
  });

  it('rejects a prose-only mention that replaces an executable workflow step', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.legacyReference?.kind === 'workflow-step');
    expect(row).toBeDefined();
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    const reference = row!.legacyReference!;
    const target = reference.marker.startsWith('scripts/') ? reference.marker : `scripts/${reference.marker}`;
    files[reference.path] = (files[reference.path] ?? '')
      .replace(new RegExp(`^\\s*run:\\s+[^\\r\\n]*${escapeRegExpLiteral(target)}[^\\r\\n]*$`, 'mu'), `      # prose-only mention: ${reference.marker}`);
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('typed legacy invocation is no longer executable');
  });


  it('rejects an unrelated child call plus a disconnected target path literal', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.legacyReference?.kind === 'test-invocation');
    expect(row).toBeDefined();
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files[row!.legacyReference!.path] = [
      "import { execFileSync } from 'node:child_process';",
      "import path from 'node:path';",
      "const repoRoot = '/fixture';",
      `const retiredPath = path.join(repoRoot, '${row!.sourcePath}');`,
      "execFileSync('node', ['some-unrelated-helper.mjs']);",
      'void retiredPath;',
      '',
    ].join('\n');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain(`${row!.id}: typed legacy invocation is no longer executable`);
  });

  it('rejects a helper-only test for a deferred PowerShell wrapper', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.id === 'check-script:scripts/check-supervisor-test-wait-inventory.ps1');
    expect(row).toBeDefined();
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files[row!.legacyReference!.path] = [
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('node', ['scripts/lib/supervisor-test-wait-inventory.mjs', 'production']);",
      '',
    ].join('\n');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain(`${row!.id}: typed legacy invocation is no longer executable`);
  });

  it('fails when a deferred legacy invocation disappears', () => {
    const census = loadCensus(repoRoot);
    const row = census.entries.find((entry) => entry.classification === 'deferred-to-named-wave' && entry.legacyReference?.path === 'scripts/verify.ps1');
    expect(row).toBeDefined();
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/verify.ps1'] = (files['scripts/verify.ps1'] ?? '').replaceAll(row!.legacyReference!.marker, 'marker removed');
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain('typed legacy invocation is no longer executable');
  });

  it('fails an invalid retirement justification that relies on caller absence', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification === 'retired-with-reason');
    const entries = [...census.entries];
    entries[index] = {
      ...entries[index]!,
      retirementJustification: {
        reasonCode: 'dead-legacy-surface',
        behavior: 'There is no current caller, so this script is not used and can be removed without discussing the behavior that it attempted to prove.',
        replacement: 'No replacement because it is unreferenced and not used by the current tree.',
      },
    };
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('caller absence');
  });

  it('fails when generated population provenance or digest drifts', () => {
    const census = clone(loadCensus(repoRoot));
    expect(validateCensusSchema({ ...census, generation: { ...census.generation, populationDigest: '0'.repeat(64) } }).join('\n')).toContain('generated population digest drift');
  });

  it('fails when the frozen baseline commit or source hashes drift', () => {
    const census = clone(loadCensus(repoRoot));
    expect(validateCensusSchema({ ...census, baseCommitSha: '0'.repeat(40) }).join('\n')).toContain('pre-change commit');
    expect(validateCensusSchema({
      ...census,
      sourceHashes: { ...census.sourceHashes, 'scripts/verify.ps1': '0'.repeat(64) },
    }).join('\n')).toContain('frozen source hash drift');
  });

  it('rejects a non-proving retired predicate from the executable runner set', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification === 'retired-with-reason');
    const entries = [...census.entries];
    entries[index] = { ...entries[index]!, gateIds: ['ghost-green'] };
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('non-ported row cannot be admitted');
  });

  it('fails on an unaccounted new check script', () => {
    const census = loadCensus(repoRoot);
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/check-new-hidden-gate.ps1'] = '# new';
    expect(evaluateCensus(census, memorySnapshot(files), registeredGateIds).details?.join('\n')).toContain('unaccounted check script');
  });

  it('discovers the deferred inline members and confirms migrated structure members are gone', () => {
    const ids = discoverVerifyInlineIds(readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8'));
    expect(ids).toContain('verify-inline:command-version:node');
    expect(ids).toContain('verify-inline:write-check:gh auth status');
    expect(ids).not.toContain('verify-inline:required-file:AGENTS.md');
    expect(ids).not.toContain('verify-inline:contract-marker:plugins/ao-task-declaration/README.md');
    expect(ids).not.toContain('verify-inline:write-check:prompts/*.md');
  });

  it('fails when a deferred inline aggregation member disappears', () => {
    const census = loadCensus(repoRoot);
    const verify = readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8')
      .replace("[void](Test-CommandVersion -Command 'node' -Minimum ([version]'20.0.0') -Required)\n", '');
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/verify.ps1'] = verify;
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain('verify-inline:command-version:node: deferred verify inline aggregation member was dropped');
  });

  it('fails when a new inline aggregation member bypasses the frozen population', () => {
    const census = loadCensus(repoRoot);
    const verify = `${readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8')}\nWrite-Check 'new-hidden-check' 'PASS'\n`;
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/verify.ps1'] = verify;
    const result = evaluateCensus(census, memorySnapshot(files), registeredGateIds);
    expect(result.details?.join('\n')).toContain('unaccounted verify.ps1 inline aggregation member');
  });

  it('fails when a ported gate id is not registered', () => {
    const result = evaluateCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), new Set());
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('registered gate missing');
  });
});
