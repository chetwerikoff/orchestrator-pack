import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard, detectUntypedFindingsInCapture, runCli } from './finding-ledger-guard.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/finding-ledger',
);
const scenarioMatrixDir = path.join(fixturesDir, 'scenario-matrix');
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  it('passes when a typed capture has no id but the ledger uses a normalized id', () => {
    const { capture, ledger } = loadFixturePair('normalized-id');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when multiple same-type captures lack ids but the ledger is incomplete', () => {
    const { capture, ledger } = loadFixturePair('same-type-no-id-partial');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/type: security/);
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

function loadScenarioFixture(name: string) {
  return {
    capture: readFileSync(path.join(scenarioMatrixDir, `${name}.capture.txt`), 'utf8'),
    ledger: readFileSync(path.join(scenarioMatrixDir, `${name}.ledger.json`), 'utf8'),
  };
}

function runFindingLedgerGuardPs1(args: string[]) {
  return spawnSync(
    'pwsh',
    ['-NoProfile', '-File', path.join(repoRoot, 'scripts/check-finding-ledger-guard.ps1'), ...args],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

describe('finding-ledger guard scenario matrix (#679)', () => {
  it('1. ignores echoed contract-evidence binding-id/binding-type fences', () => {
    const { capture, ledger } = loadScenarioFixture('echo-contract-evidence');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(true);
    expect(result.captureFindings).toEqual([]);
    expect(result.protectedSignals).toEqual([]);
  });

  it('2. ignores echoed review rubric example type tags and scope vocabulary', () => {
    const { capture, ledger } = loadScenarioFixture('echo-rubric');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(true);
    expect(result.captureFindings).toEqual([]);
    expect(result.protectedSignals).toEqual([]);
  });

  it('3. still catches a genuine reviewer type: security finding absent from the ledger', () => {
    const { capture, ledger } = loadScenarioFixture('genuine-security');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sec-spawn-grant|security/);
  });

  it('3b. still catches bracketed [P1] - security finding headers after echoed artifact', () => {
    const { capture, ledger } = loadScenarioFixture('genuine-security-bracketed');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sec-bracketed|security/);
  });

  it('4. still catches a genuine reviewer type: scope-violation finding absent from the ledger', () => {
    const { capture, ledger } = loadScenarioFixture('genuine-scope-violation');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/scope-vendor|scope-violation/);
  });

  it('5. ignores echoed draft denylist fence and Files out of scope heading', () => {
    const { capture, ledger } = loadScenarioFixture('echo-draft-body');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(true);
    expect(result.captureFindings).toEqual([]);
    expect(result.protectedSignals).toEqual([]);
  });

  it('6. mirrors .mjs exit codes in the .ps1 wrapper', () => {
    const failingCapture = path.join(fixturesDir, 'security-rejected.capture.txt');
    const failingLedger = path.join(fixturesDir, 'security-rejected.ledger.json');
    const cleanCapture = path.join(scenarioMatrixDir, 'header-verdict-clean.capture.txt');
    const cleanLedger = path.join(scenarioMatrixDir, 'header-verdict-clean.ledger.json');

    const mjsFail = runCli([
      'node',
      'finding-ledger-guard.mjs',
      '--capture',
      failingCapture,
      '--ledger',
      failingLedger,
    ]);
    const ps1Fail = runFindingLedgerGuardPs1([
      '-CapturePath',
      failingCapture,
      '-LedgerPath',
      failingLedger,
    ]);
    expect(mjsFail).toBe(1);
    expect(ps1Fail.status).toBe(mjsFail);

    const mjsPass = runCli([
      'node',
      'finding-ledger-guard.mjs',
      '--capture',
      cleanCapture,
      '--ledger',
      cleanLedger,
    ]);
    const ps1Pass = runFindingLedgerGuardPs1([
      '-CapturePath',
      cleanCapture,
      '-LedgerPath',
      cleanLedger,
    ]);
    expect(mjsPass).toBe(0);
    expect(ps1Pass.status).toBe(mjsPass);
  });

  it('passes on a header+verdict clean corpus and fails on genuine un-ledgered security', () => {
    const clean = loadScenarioFixture('header-verdict-clean');
    expect(checkFindingLedgerGuard(clean.capture, clean.ledger).ok).toBe(true);

    const genuine = loadScenarioFixture('genuine-security');
    expect(checkFindingLedgerGuard(genuine.capture, genuine.ledger).ok).toBe(false);
  });
});
