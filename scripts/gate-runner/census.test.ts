import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverVerifyInlineIds, evaluateCensus, loadCensus, validateCensusSchema, type GateCensus } from './census.ts';
import { captureSourceSnapshot, memorySnapshot } from './source-snapshot.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const registered = new Set([
  'agent-rules-live-reference',
  'agent-rules-size-budget',
  'agent-rules-moved-content',
  'ao-capture-redaction',
]);

function clone(census: GateCensus): GateCensus {
  return JSON.parse(JSON.stringify(census)) as GateCensus;
}

describe('frozen gate population census', () => {
  it('reconciles the real final tree', () => {
    const result = evaluateCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), registered);
    expect(result.status, result.details?.join('\n')).toBe('PASS');
  });

  it('fails on an unaccounted baseline row or committed count drift', () => {
    const census = clone(loadCensus(repoRoot)) as GateCensus & { entries: GateCensus['entries'] };
    const altered = { ...census, entries: census.entries.slice(1) } as GateCensus;
    expect(validateCensusSchema(altered).join('\n')).toContain('populationCount');
  });

  it('fails when check-reusable changes while all of its behaviors remain legacy-enforced', () => {
    const census = loadCensus(repoRoot);
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/check-reusable.ps1'] = `${files['scripts/check-reusable.ps1'] ?? ''}\n# hidden behavior\n`;
    const result = evaluateCensus(census, memorySnapshot(files), registered);
    expect(result.details?.join('\n')).toContain('check-reusable.ps1 behavior surface drifted without census reclassification');
  });

  it('fails when a deferred legacy invocation disappears', () => {
    const census = clone(loadCensus(repoRoot));
    const row = census.entries.find((entry) => entry.classification === 'still-enforced-by-legacy' && entry.legacyReference?.path === 'scripts/check-reusable.ps1');
    expect(row).toBeDefined();
    const snapshot = memorySnapshot({
      'scripts/verify.ps1': 'scripts/gate-runner/runner.ts',
      'scripts/check-reusable.ps1': 'marker removed',
      [row!.sourcePath]: '# exists',
    });
    expect(evaluateCensus(census, snapshot, registered).details?.join('\n')).toContain('cited legacy invocation');
  });

  it('fails an invalid retirement justification that relies on caller absence', () => {
    const census = clone(loadCensus(repoRoot));
    const index = census.entries.findIndex((entry) => entry.classification === 'retired-with-justification');
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
    const index = census.entries.findIndex((entry) => entry.classification === 'retired-with-justification');
    const entries = [...census.entries];
    entries[index] = { ...entries[index]!, gateIds: ['ghost-green'] };
    expect(validateCensusSchema({ ...census, entries }).join('\n')).toContain('cannot be admitted to the runner');
  });

  it('fails on an unaccounted new check script', () => {
    const census = loadCensus(repoRoot);
    const verify = readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8');
    const snapshot = memorySnapshot({
      'scripts/verify.ps1': verify,
      'scripts/check-reusable.ps1': readFileSync(resolve(repoRoot, 'scripts/check-reusable.ps1'), 'utf8'),
      'scripts/check-new-hidden-gate.ps1': '# new',
    });
    expect(evaluateCensus(census, snapshot, registered).details?.join('\n')).toContain('unaccounted check script');
  });


  it('discovers command, required-file, contract-marker, and named Write-Check members', () => {
    const ids = discoverVerifyInlineIds(readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8'));
    expect(ids).toContain('verify-inline:command-version:node');
    expect(ids).toContain('verify-inline:required-file:AGENTS.md');
    expect(ids).toContain('verify-inline:contract-marker:plugins/ao-task-declaration/README.md');
    expect(ids).toContain('verify-inline:write-check:gh auth status');
  });

  it('fails when a deferred inline aggregation member disappears', () => {
    const census = loadCensus(repoRoot);
    const verify = readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8')
      .replace("[void](Test-CommandVersion -Command 'node' -Minimum ([version]'20.0.0') -Required)\n", '');
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/verify.ps1'] = verify;
    const result = evaluateCensus(census, memorySnapshot(files), registered);
    expect(result.details?.join('\n')).toContain('verify-inline:command-version:node: deferred verify inline aggregation member was dropped');
  });

  it('fails when a new inline aggregation member bypasses the frozen population', () => {
    const census = loadCensus(repoRoot);
    const verify = `${readFileSync(resolve(repoRoot, 'scripts/verify.ps1'), 'utf8')}\nWrite-Check 'new-hidden-check' 'PASS'\n`;
    const snapshot = captureSourceSnapshot(repoRoot);
    const files = Object.fromEntries(snapshot.files);
    files['scripts/verify.ps1'] = verify;
    const result = evaluateCensus(census, memorySnapshot(files), registered);
    expect(result.details?.join('\n')).toContain('unaccounted verify.ps1 inline aggregation member');
  });

  it('fails when a ported gate id is not registered', () => {
    const result = evaluateCensus(loadCensus(repoRoot), captureSourceSnapshot(repoRoot), new Set());
    expect(result.status).toBe('FAIL');
    expect(result.details?.join('\n')).toContain('registered gate missing');
  });
});
