import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard, detectUntypedFindingsInCapture, runCli } from './finding-ledger-guard.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/finding-ledger',
);

function loadFixturePair(name: string) {
  return {
    capture: readFileSync(path.join(fixturesDir, `${name}.capture.txt`), 'utf8'),
    ledger: readFileSync(path.join(fixturesDir, `${name}.ledger.json`), 'utf8'),
  };
}

describe('finding-ledger guard fails when a protected finding is rejected or omitted and passes on a complete ledger', () => {
  it('fails when a security finding is rejected', () => {
    const { capture, ledger } = loadFixturePair('security-rejected');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/security/);
  });

  it('fails when a protected finding is omitted from the ledger', () => {
    const { capture, ledger } = loadFixturePair('security-omitted');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/scope-violation|protected signal/);
  });

  it('fails when multiple findings share a type but only one has a ledger row', () => {
    const { capture, ledger } = loadFixturePair('same-type-partial');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sec-credential-log/);
  });

  it('fails when a protected finding is reclassified in the ledger', () => {
    const { capture, ledger } = loadFixturePair('protected-reclassified');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/reclassified/);
  });

  it('fails when an early pass finding is omitted but the final pass is NO_FINDINGS', () => {
    const multiPassDir = path.join(fixturesDir, 'multi-pass');
    const captures = readdirSync(multiPassDir)
      .filter((name) => name.endsWith('.capture.txt'))
      .sort()
      .map((name) => readFileSync(path.join(multiPassDir, name), 'utf8'));
    const ledger = readFileSync(
      path.join(multiPassDir, 'finding-disposition-ledger.json'),
      'utf8',
    );
    const result = checkFindingLedgerGuard(captures, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sec-spawn-grant/);
  });

  it('validates all capture files in a directory via CLI', () => {
    const capturesDir = path.join(fixturesDir, 'multi-pass');
    const ledgerPath = path.join(capturesDir, 'finding-disposition-ledger.json');
    expect(
      runCli([
        'node',
        'finding-ledger-guard.mjs',
        '--captures-dir',
        capturesDir,
        '--ledger',
        ledgerPath,
      ]),
    ).toBe(1);
  });

  it('fails when a capture appends NO_FINDINGS but still emits a protected finding', () => {
    const { capture, ledger } = loadFixturePair('no-findings-with-finding');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sec-spawn-grant|security/);
  });

  it('fails when a capture contains an untyped priority finding', () => {
    const { capture, ledger } = loadFixturePair('untyped-finding');
    expect(detectUntypedFindingsInCapture(capture)).toHaveLength(1);
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/untyped capture finding/);
  });

  it('passes when every captured finding is recorded and protected ones are addressed', () => {
    const { capture, ledger } = loadFixturePair('complete');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('exits non-zero on CLI for protected rejection fixtures', () => {
    const capturePath = path.join(fixturesDir, 'security-rejected.capture.txt');
    const ledgerPath = path.join(fixturesDir, 'security-rejected.ledger.json');
    expect(runCli(['node', 'finding-ledger-guard.mjs', '--capture', capturePath, '--ledger', ledgerPath])).toBe(1);
  });

  it('exits zero on CLI for complete ledger fixtures', () => {
    const capturePath = path.join(fixturesDir, 'complete.capture.txt');
    const ledgerPath = path.join(fixturesDir, 'complete.ledger.json');
    expect(runCli(['node', 'finding-ledger-guard.mjs', '--capture', capturePath, '--ledger', ledgerPath])).toBe(0);
  });
});
