import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkFindingLedgerGuard,
  detectProtectedSignalsInCapture,
  detectTypedFindingsInCapture,
  detectUntypedFindingsInCapture,
  runCli,
} from './finding-ledger-guard.mjs';
import {
  fingerprintProtectedSignalSpan,
  PROTECTED_SIGNAL_RECEIPT_FILENAME,
} from './lib/protected-signal-receipt.mjs';

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

function runDraftDisciplineFindingLedgerPs1(args: string[]) {
  return spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(repoRoot, 'scripts/check-draft-discipline.ps1'),
      '-Command',
      'finding-ledger',
      ...args,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

function writeTempFindingLedgerPair(name: string, capture: string, ledger: string) {
  const dir = mkdtempSync(path.join(tmpdir(), `finding-ledger-${name}-`));
  const capturePath = path.join(dir, `${name}.capture.txt`);
  const ledgerPath = path.join(dir, `${name}.ledger.json`);
  writeFileSync(capturePath, capture);
  writeFileSync(ledgerPath, ledger);
  return { capturePath, ledgerPath };
}

function writeTempFindingLedgerReceiptFixture(name: string, capture: string, ledger: string) {
  const root = mkdtempSync(path.join(tmpdir(), `finding-ledger-receipt-${name}-`));
  const draftDir = path.join(root, 'docs/issues_drafts');
  const draftPath = path.join(draftDir, `${name}.md`);
  const reviewDir = path.join(draftDir, '.review', name);
  const capturePath = path.join(root, `${name}.capture.txt`);
  const ledgerPath = path.join(root, `${name}.ledger.json`);

  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(draftPath, '# fixture draft\n');
  writeFileSync(capturePath, capture);
  writeFileSync(ledgerPath, ledger);
  writeFileSync(path.join(reviewDir, 'decision-log.md'), 'architect adjudicated the false positive\n');
  writeFileSync(
    path.join(reviewDir, PROTECTED_SIGNAL_RECEIPT_FILENAME),
    JSON.stringify({
      'recorded-at': '2026-07-13T12:00:00.000Z',
      'decision-log': 'decision-log.md',
      entries: [
        {
          guard: 'finding-ledger',
          signal: 'scope-violation',
          fingerprint: fingerprintProtectedSignalSpan('scope-violation'),
          reason: 'architect-false-positive',
          rationale: 'The capture quotes a protected signal that was adjudicated locally.',
        },
      ],
    }),
  );

  return { root, draftPath, capturePath, ledgerPath };
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

  it('3c. still catches typed-only security findings without P0/[P0] headers after echoed artifact', () => {
    const { capture, ledger } = loadScenarioFixture('genuine-security-typed-only');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sec-typed-only|security/);
  });

  it('3d. still catches inline type:/id: security findings after echoed artifact', () => {
    const { capture, ledger } = loadScenarioFixture('genuine-security-inline');
    const result = checkFindingLedgerGuard(capture, ledger);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sec-inline|security/);
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

describe('finding-ledger guard treats a backtick-quoted type tag as a quote but keeps other protected vocabulary', () => {
  it('does not read a backtick-quoted `type: security` tag as an emitted protected finding', () => {
    const capture = [
      'type: spec; id: carveout-wording',
      'The draft amends the `type: security` carve-out so the ledger contract is consistent.',
    ].join('\n');
    expect(detectProtectedSignalsInCapture(capture)).toEqual([]);
    expect(detectTypedFindingsInCapture(capture).map((f) => f.type)).toEqual(['spec']);
  });

  it('still detects a genuine unquoted type: security finding', () => {
    const capture = ['type: security; id: real-leak', 'A credential is exposed to PR-controlled code.'].join(
      '\n',
    );
    expect(detectProtectedSignalsInCapture(capture)).toContain('security');
  });

  it('still treats unquoted protected vocabulary a real finding cites as a scope-violation signal', () => {
    const capture = 'A finding: this change edits denylist paths outside the declared scope.';
    expect(detectProtectedSignalsInCapture(capture)).toContain('scope-violation');
  });

  it('passes a ledger whose only security mention in the capture is a backtick-quoted type tag', () => {
    const capture = [
      'type: spec; id: carveout-wording',
      'Reword the `type: security` clause so the ledger contract is consistent.',
    ].join('\n');
    const ledger = JSON.stringify({
      version: 1,
      draft: 'x',
      findings: [{ id: 'carveout-wording', summary: 's', type: 'spec', disposition: 'addressed' }],
    });
    expect(checkFindingLedgerGuard(capture, ledger).ok).toBe(true);
  });

  it('documents the finding-ledger quotation delimiter forms and fail-closed malformed behavior', () => {
    const examples = [
      'Inline code span: `type: scope-violation`',
      ['```text', 'type: security', '```'].join('\n'),
      '> [P1 security] quoted rubric row\n',
      '"/\\btype:\\s*security\\b/i"',
      "'type: scope-violation; id: fixture-scope'",
    ];

    for (const example of examples) {
      expect(detectProtectedSignalsInCapture(example), example).toEqual([]);
    }

    expect(detectProtectedSignalsInCapture('"type: scope-violation')).toContain('scope-violation');
  });

  it('does not treat apostrophe contractions as quoted protected-signal spans', () => {
    const capture = "Don't mark this out of scope because it's risky.";
    expect(detectProtectedSignalsInCapture(capture)).toContain('scope-violation');
  });

  it('does not hide operative inline-code policy terms in findings', () => {
    const capture = [
      'type: spec; id: policy-inline',
      'This finding says the change is out of `allowed_roots` and touches `denylist`.',
    ].join('\n');
    const ledger = JSON.stringify({
      version: 1,
      draft: 'inline-policy-terms',
      findings: [
        {
          id: 'policy-inline',
          summary: 'Policy name formatting should still be operative.',
          type: 'spec',
          disposition: 'addressed',
        },
      ],
    });
    expect(detectProtectedSignalsInCapture(capture)).toContain('scope-violation');
    expect(checkFindingLedgerGuard(capture, ledger).ok).toBe(false);
  });

  it('passes draft-273-shaped quoted evidence without fabricated protected coverage', () => {
    const capture = [
      'type: spec; id: evidence-quote',
      'The reviewer cites the draft boundary: "type: scope-violation; id: scope-boundary; denylist and allowed_roots text is copied evidence."',
    ].join('\n');
    const ledger = JSON.stringify({
      version: 1,
      draft: 'quote-evidence-protected-signal',
      findings: [
        {
          id: 'evidence-quote',
          summary: 'Reviewer cited draft evidence.',
          type: 'spec',
          disposition: 'addressed',
        },
      ],
    });
    expect(detectTypedFindingsInCapture(capture).map((finding) => finding.type)).toEqual(['spec']);
    expect(detectProtectedSignalsInCapture(capture)).toEqual([]);
    expect(checkFindingLedgerGuard(capture, ledger).ok).toBe(true);

    const { capturePath, ledgerPath } = writeTempFindingLedgerPair('quote-evidence', capture, ledger);
    expect(runCli(['node', 'finding-ledger-guard.mjs', '--capture', capturePath, '--ledger', ledgerPath])).toBe(0);
    expect(
      runFindingLedgerGuardPs1(['-CapturePath', capturePath, '-LedgerPath', ledgerPath]).status,
    ).toBe(0);
  });

  it('rejects genuine unquoted, mixed, and malformed protected finding-ledger signals', () => {
    const ledger = JSON.stringify({
      version: 1,
      draft: 'scope-signal',
      findings: [
        {
          id: 'evidence-quote',
          summary: 'Reviewer cited draft evidence.',
          type: 'spec',
          disposition: 'addressed',
        },
      ],
    });
    const cases = new Map([
      [
        'genuine-unquoted',
        [
          'type: spec; id: evidence-quote',
          'The reviewer cites the draft boundary.',
          '',
          'type: scope-violation; id: scope-boundary',
          'This change edits denylist paths outside allowed_roots.',
        ].join('\n'),
      ],
      [
        'mixed',
        [
          'type: spec; id: evidence-quote',
          'The reviewer cites the draft boundary: "type: scope-violation; id: quoted-scope; denylist text is copied evidence."',
          '',
          'type: scope-violation; id: real-scope',
          'The change still edits denylist paths outside allowed_roots.',
        ].join('\n'),
      ],
      [
        'malformed',
        [
          'type: spec; id: evidence-quote',
          'The reviewer starts a quote but never closes it: "type: scope-violation; id: scope-boundary; denylist and allowed_roots text.',
        ].join('\n'),
      ],
    ]);

    for (const [name, capture] of cases) {
      expect(detectProtectedSignalsInCapture(capture), name).toContain('scope-violation');
      expect(checkFindingLedgerGuard(capture, ledger).ok, name).toBe(false);

      const { capturePath, ledgerPath } = writeTempFindingLedgerPair(name, capture, ledger);
      expect(runCli(['node', 'finding-ledger-guard.mjs', '--capture', capturePath, '--ledger', ledgerPath])).toBe(1);
      expect(
        runFindingLedgerGuardPs1(['-CapturePath', capturePath, '-LedgerPath', ledgerPath]).status,
      ).toBe(1);
    }
  });

  it('forwards draft context through check-draft-discipline finding-ledger mode', () => {
    const ledger = JSON.stringify({ version: 1, draft: 'receipt-fixture', findings: [] });
    const fixture = writeTempFindingLedgerReceiptFixture(
      'receipt-fixture',
      'Reviewer prose says this draft has a scope-violation false positive.',
      ledger,
    );

    try {
      const result = runDraftDisciplineFindingLedgerPs1([
        '-DraftPath',
        fixture.draftPath,
        '-CapturePath',
        fixture.capturePath,
        '-LedgerPath',
        fixture.ledgerPath,
        '-RepoRoot',
        fixture.root,
      ]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
