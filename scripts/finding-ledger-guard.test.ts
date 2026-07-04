import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard, runCli } from './finding-ledger-guard.mjs';

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
