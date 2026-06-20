import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalBindingIdentity,
  canonicalProducer,
  checkContractEvidence,
  extractAuthoritativeContractEvidenceBody,
  verifyCaptureManifestIntegrity,
} from './contract-evidence.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDraftDir = path.join(repoRoot, 'tests/fixtures/draft-discipline/contract-evidence');
const fixtureManifest = 'tests/fixtures/contract-evidence/capture-manifest.json';
const productionManifest = 'tests/external-output-references/capture-manifest.json';
const legacyList = 'tests/fixtures/draft-discipline/contract-evidence/legacy-list.json';

function loadDraft(name: string): string {
  return readFileSync(path.join(fixtureDraftDir, name), 'utf8');
}

function checkFixture(name: string, expectPass: boolean, draftPath?: string) {
  const result = checkContractEvidence(loadDraft(name), {
    repoRoot,
    manifestPath: fixtureManifest,
    legacyListPath: legacyList,
    draftPath: draftPath ?? `tests/fixtures/draft-discipline/contract-evidence/${name}`,
  });
  expect(result.ok).toBe(expectPass);
  return result;
}

describe('checkContractEvidence fixtures', () => {
  it('passes a grounded capture-backed row', () => {
    checkFixture('grounded-pass.md', true);
  });

  it('passes explicit contract-evidence none', () => {
    checkFixture('explicit-none.md', true);
  });

  it('rejects absent contract-evidence block', () => {
    const result = checkFixture('absent-block.md', false);
    expect(result.errors.join(' ')).toMatch(/missing/i);
  });

  it('rejects malformed rows', () => {
    const result = checkFixture('malformed-row.md', false);
    expect(result.errors.join(' ')).toMatch(/malformed|missing required field/i);
  });

  it('rejects missing manifest entries', () => {
    const result = checkFixture('missing-manifest-entry.md', false);
    expect(result.errors.join(' ')).toMatch(/does not exist/i);
  });

  it('rejects producer mismatch', () => {
    const result = checkFixture('producer-mismatch.md', false);
    expect(result.errors.join(' ')).toMatch(/does not match manifest producer/i);
  });

  it('rejects selector value mismatch with redacted diagnostics', () => {
    const result = checkFixture('selector-mismatch.md', false);
    expect(result.errors.join(' ')).toMatch(/does not match expected/i);
    expect(result.errors.join(' ')).toMatch(/redacted capture/i);
    expect(result.errors.join(' ')).not.toMatch(/"reportState"/);
  });

  it('rejects token evidence for structured object captures', () => {
    const result = checkFixture('token-structured-object.md', false);
    expect(result.errors.join(' ')).toMatch(/not allowed for structured/i);
  });

  it('rejects token evidence for scalar JSON captures', () => {
    const result = checkFixture('token-structured-scalar.md', false);
    expect(result.errors.join(' ')).toMatch(/not allowed for structured/i);
  });

  it('rejects token evidence for array JSON captures', () => {
    const result = checkFixture('token-structured-array.md', false);
    expect(result.errors.join(' ')).toMatch(/not allowed for structured/i);
  });

  it('rejects unstructured captures without token', () => {
    const result = checkFixture('unstructured-missing-token.md', false);
    expect(result.errors.join(' ')).toMatch(/requires token/i);
  });

  it('rejects NEW rows without a named acceptance criterion', () => {
    const result = checkFixture('new-no-ac.md', false);
    expect(result.errors.join(' ')).toMatch(/producer-emission/i);
  });

  it('rejects NEW rows that only name consumer assertions', () => {
    const result = checkFixture('new-consumer-only-ac.md', false);
    expect(result.errors.join(' ')).toMatch(/producer-emission|matching producer-emission/i);
  });

  it('rejects NEW rows when producer-emission does not match the binding', () => {
    const result = checkFixture('new-unmatched-emission-ac.md', false);
    expect(result.errors.join(' ')).toMatch(/matching producer-emission/i);
  });

  it('rejects NEW rows when producer-emission lacks executable proof', () => {
    const result = checkFixture('new-missing-proof.md', false);
    expect(result.errors.join(' ')).toMatch(/executable proof|proof-command|proof-capture|producer-emission/i);
  });

  it('rejects NEW rows for external gh producer', () => {
    const result = checkFixture('new-external-gh.md', false);
    expect(result.errors.join(' ')).toMatch(/external producer/i);
  });

  it('rejects NEW rows for external codex alias producer', () => {
    const result = checkFixture('new-external-alias.md', false);
    expect(result.errors.join(' ')).toMatch(/external producer/i);
  });

  it('rejects NEW rows when binding-id names an external producer but row.producer does not', () => {
    const result = checkFixture('new-external-binding-id-mismatch.md', false);
    expect(result.errors.join(' ')).toMatch(/does not match binding-id producer|external producer/i);
  });

  it('passes well-formed repo-owned NEW rows', () => {
    checkFixture('new-repo-owned-pass.md', true);
  });

  it('anchors NEW AC lookup to the acceptance criteria section', () => {
    checkFixture('new-ac-section-anchored-pass.md', true);
  });

  it('rejects conflicting duplicate binding identities', () => {
    const result = checkFixture('duplicate-identity-conflict.md', false);
    expect(result.errors.join(' ')).toMatch(/conflicting binding assertion/i);
  });

  it('rejects conflicting expected values that share one capture reference', () => {
    const result = checkFixture('shared-evidence-conflicting-expected.md', false);
    expect(result.errors.join(' ')).toMatch(/conflicting binding assertion/i);
  });

  it('rejects conflicting NEW assertions with the same binding identity', () => {
    const result = checkFixture('new-shared-identity-conflict.md', false);
    expect(result.errors.join(' ')).toMatch(/conflicting binding assertion/i);
  });

  it('rejects CLI behavior captures with failed exit status', () => {
    const result = checkFixture('cli-behavior-failed-exit.md', false);
    expect(result.errors.join(' ')).toMatch(/exit status/i);
  });

  it('rejects CLI behavior rows that trust a nonzero manifest exit status', () => {
    const result = checkFixture('cli-behavior-nonzero-trusted.md', false);
    expect(result.errors.join(' ')).toMatch(/successful capture/i);
  });

  it('passes CLI behavior captures with successful exit status', () => {
    checkFixture('cli-behavior-pass.md', true);
  });

  it('passes structured JSON CLI behavior captures', () => {
    checkFixture('cli-behavior-structured-pass.md', true);
  });

  it('rejects CLI option bindings that bypass exit checks via help-text captures', () => {
    const result = checkFixture('cli-option-help-bypass.md', false);
    expect(result.errors.join(' ')).toMatch(/binding-type cli-behavior|requires binding-type cli-behavior/i);
  });

  it('rejects CLI behavior rows grounded on help-only capture commands', () => {
    const result = checkFixture('cli-behavior-help-only.md', false);
    expect(result.errors.join(' ')).toMatch(/help-only capture command|does not exercise binding target/i);
  });

  it('grandfathers legacy drafts without a block', () => {
    const result = checkContractEvidence(loadDraft('legacy-grandfather.md'), {
      repoRoot,
      manifestPath: fixtureManifest,
      legacyListPath: legacyList,
      draftPath: 'tests/fixtures/draft-discipline/contract-evidence/legacy-grandfather.md',
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it('ignores fenced-only contract-evidence examples', () => {
    const result = checkFixture('fenced-only-none.md', false);
    expect(result.errors.join(' ')).toMatch(/missing/i);
  });

  it('ignores contract-evidence fences in the full Example section', () => {
    const result = checkFixture('example-section-spaced-none.md', false);
    expect(result.errors.join(' ')).toMatch(/missing/i);
  });

  it('resolves manifest capture paths containing spaces', () => {
    checkFixture('path-with-spaces-pass.md', true);
  });

  it('rejects coworker-found rows without real capture grounding', () => {
    const result = checkFixture('coworker-fake-found.md', false);
    expect(result.errors.join(' ')).toMatch(/does not exist/i);
  });
});

describe('capture manifest integrity', () => {
  it('matches regenerated production manifest', () => {
    const result = verifyCaptureManifestIntegrity(repoRoot, productionManifest);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('rejects production manifests with a non-pinned corpusRoot', () => {
    const committed = JSON.parse(
      readFileSync(path.join(repoRoot, productionManifest), 'utf8'),
    );
    const tampered = structuredClone(committed);
    tampered.corpusRoot = 'tests/fixtures/contract-evidence';
    const tempDir = mkdtempSync(path.join(tmpdir(), 'capture-manifest-corpus-'));
    const prodDir = path.join(tempDir, 'tests/external-output-references');
    mkdirSync(prodDir, { recursive: true });
    const tempPath = path.join(prodDir, 'capture-manifest.json');
    writeFileSync(tempPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const result = verifyCaptureManifestIntegrity(
      tempDir,
      'tests/external-output-references/capture-manifest.json',
    );
    rmSync(tempDir, { recursive: true, force: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/corpusRoot must be tests\/external-output-references/i);
  });

  it('rejects hand-edited manifest entries', () => {
    const committed = JSON.parse(
      readFileSync(path.join(repoRoot, fixtureManifest), 'utf8'),
    );
    const tampered = structuredClone(committed);
    tampered.entries['ao-worker-report/fixing_ci'] = {
      ...tampered.entries['ao-worker-report/fixing_ci'],
      sourceCommand: 'hand-authored plausible command',
    };
    const tempDir = mkdtempSync(path.join(tmpdir(), 'capture-manifest-tampered-'));
    const tempPath = path.join(tempDir, 'capture-manifest.json');
    writeFileSync(tempPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const result = checkContractEvidence(loadDraft('grounded-pass.md'), {
      repoRoot,
      manifestPath: tempPath,
      legacyListPath: legacyList,
      draftPath: 'tests/fixtures/draft-discipline/contract-evidence/grounded-pass.md',
    });
    rmSync(tempDir, { recursive: true, force: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/does not match regenerated/i);
  });
});

describe('canonical binding identity', () => {
  it('collapses alias producers and selector spellings', () => {
    const rowA = {
      'binding-id': 'gh-cli:number:1',
      producer: 'gh-cli',
      selector: '$.number',
      expected: '1',
      evidence: 'capture@gh-pr-open/open',
    };
    const rowB = {
      'binding-id': 'gh:number:1',
      producer: 'gh',
      selector: 'number',
      expected: '1',
      evidence: 'capture@gh-pr-open/open',
    };
    expect(canonicalProducer(rowA.producer)).toBe('gh');
    expect(canonicalBindingIdentity(rowA, 'structured')).toBe(
      canonicalBindingIdentity(rowB, 'structured'),
    );
  });
});

describe('authoritative block extraction', () => {
  it('returns none only from canonical fences', () => {
    const body = extractAuthoritativeContractEvidenceBody(loadDraft('explicit-none.md'));
    expect(body).toBe('none');
  });
});
