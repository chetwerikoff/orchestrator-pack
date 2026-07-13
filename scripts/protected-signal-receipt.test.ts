import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkTierGateGuard,
} from './lib/tier-gate-core.js';
import { resetMarkerClassCache } from './lib/tier-marker-screen.js';
import {
  collectProtectedSignalMatches,
  fingerprintProtectedSignalSpan,
  PROTECTED_SIGNAL_RECEIPT_FILENAME,
  suppressProtectedSignalHits,
} from './lib/protected-signal-receipt.mjs';
import {
  checkFindingLedgerGuard,
} from './finding-ledger-guard.mjs';
import {
  syncPublishIssueBody,
  validateFindingLedgerGuardReceipt,
  validateTierGateGuardReceipt,
} from './lib/publish-issue-body-sync.js';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'protected-signal-receipt-'));
  mkdirSync(join(root, 'docs/issues_drafts/.review'), { recursive: true });
  resetMarkerClassCache();
  return root;
}

function draftText(marker = 'concurrency-state-retry') {
  return `# Receipt fixture

## Goal

Exercise a protected marker phrase: ${marker}.

\`\`\`behavior-kind
action-producing
\`\`\`

\`\`\`complexity-tier
tier: T1
advisory-prior: T1
\`\`\`

\`\`\`positive-outcome
asserts: fixture demonstrates the receipt path
input: realistic
\`\`\`

\`\`\`contract-evidence
none
\`\`\`

\`\`\`denylist
vendor/**
\`\`\`

\`\`\`allowed-roots
scripts/**
\`\`\`

## Acceptance criteria

1. The fixture is intentionally small.

## Verification

- npx vitest run -t protected-signal-receipt
`;
}

function writeDraft(root: string, stem = 'receipt-draft', text = draftText()) {
  const draftPath = join(root, 'docs/issues_drafts', `${stem}.md`);
  mkdirSync(join(root, 'docs/issues_drafts'), { recursive: true });
  writeFileSync(draftPath, text);
  return draftPath;
}

function writeReceipt(root: string, stem: string, entries: unknown[], overrides: Record<string, unknown> = {}) {
  const reviewDir = join(root, 'docs/issues_drafts/.review', stem);
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(reviewDir, 'decision-log.md'), 'architect adjudicated this false positive\n');
  writeFileSync(
    join(reviewDir, PROTECTED_SIGNAL_RECEIPT_FILENAME),
    JSON.stringify({
      'recorded-at': '2026-07-13T12:00:00.000Z',
      'decision-log': 'decision-log.md',
      entries,
      ...overrides,
    }),
  );
  return reviewDir;
}

function receiptEntry(guard: string, signal: string, span: string, extra: Record<string, unknown> = {}) {
  return {
    guard,
    signal,
    fingerprint: fingerprintProtectedSignalSpan(span),
    reason: 'architect-false-positive',
    rationale: 'The phrase is quoted in a guard-about draft and was adjudicated locally.',
    ...extra,
  };
}

describe('protected-signal-receipt helper', () => {
  it('preserves unmatched hits when only one span for a signal is receipted', () => {
    const signal = 'concurrency-state-retry';
    const matches = collectProtectedSignalMatches('concurrency retry semantics', [
      { signal, pattern: /\bconcurrency\b/i },
      { signal, pattern: /\bretry\s+semantics\b/i },
    ]);
    const result = suppressProtectedSignalHits(
      [signal],
      matches,
      {
        invalid: false,
        entries: [receiptEntry('tier-marker', signal, 'concurrency')],
      },
      'tier-marker',
    );

    expect(result.hits).toEqual([signal]);
    expect(result.suppressed).toEqual([
      {
        signal,
        fingerprint: fingerprintProtectedSignalSpan('concurrency'),
        occurrence: 0,
      },
    ]);
  });
});

describe('protected-signal-receipt tier-gate', () => {
  it('suppresses a fingerprint-matched tier marker and fails when absent or stale', () => {
    const root = makeRepo();
    const draftPath = writeDraft(root);

    expect(checkTierGateGuard(draftText(), { repoRoot: process.cwd(), draftPath }).ok).toBe(false);

    writeReceipt(root, 'receipt-draft', [
      receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency'),
    ]);
    expect(checkTierGateGuard(draftText(), { repoRoot: process.cwd(), draftPath }).ok).toBe(true);

    const stale = draftText('retry semantics');
    expect(checkTierGateGuard(stale, { repoRoot: process.cwd(), draftPath }).ok).toBe(false);
  });

  it('fails closed for malformed receipt schema', () => {
    const root = makeRepo();
    const draftPath = writeDraft(root);
    writeReceipt(root, 'receipt-draft', [
      {
        guard: 'tier-marker',
        signal: 'concurrency-state-retry',
        reason: 'unknown',
        rationale: 'invalid reason makes the whole receipt unusable',
      },
    ]);

    expect(checkTierGateGuard(draftText(), { repoRoot: process.cwd(), draftPath }).ok).toBe(false);
  });

  it('fails closed when decision-log uses traversal segments even if it resolves inside the review dir', () => {
    const root = makeRepo();
    const draftPath = writeDraft(root);
    const reviewDir = writeReceipt(
      root,
      'receipt-draft',
      [receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency')],
      { 'decision-log': 'subdir/../decision-log.md' },
    );
    mkdirSync(join(reviewDir, 'subdir'), { recursive: true });

    expect(checkTierGateGuard(draftText(), { repoRoot: process.cwd(), draftPath }).ok).toBe(false);
  });

  it('requires occurrence when duplicate spans share the same fingerprint', () => {
    const root = makeRepo();
    const text = draftText('concurrency concurrency');
    const draftPath = writeDraft(root, 'receipt-draft', text);

    writeReceipt(root, 'receipt-draft', [
      receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency'),
    ]);
    expect(checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath }).ok).toBe(false);

    writeReceipt(root, 'receipt-draft', [
      receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency', { occurrence: 1 }),
    ]);
    expect(checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath }).ok).toBe(false);

    writeReceipt(root, 'receipt-draft', [
      receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency', { occurrence: 0 }),
      receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency', { occurrence: 1 }),
    ]);
    expect(checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath }).ok).toBe(true);
  });
});

describe('protected-signal-receipt ledger', () => {
  it('suppresses a fingerprint-matched protected signal and preserves recall otherwise', () => {
    const root = makeRepo();
    const draftPath = writeDraft(root, 'ledger-draft');
    const capture = 'Reviewer prose says this draft has a scope-violation false positive.';
    const ledger = '{"findings":[]}';

    expect(checkFindingLedgerGuard(capture, ledger, { repoRoot: root, draftPath }).ok).toBe(false);

    writeReceipt(root, 'ledger-draft', [
      receiptEntry('finding-ledger', 'scope-violation', 'scope-violation'),
    ]);
    expect(checkFindingLedgerGuard(capture, ledger, { repoRoot: root, draftPath }).ok).toBe(true);

    const unadjudicated = 'Reviewer prose says this draft has a security issue.';
    expect(checkFindingLedgerGuard(unadjudicated, ledger, { repoRoot: root, draftPath }).ok).toBe(false);
  });
});

describe('protected-signal-receipt sync', () => {
  it('honors tier-gate and finding-ledger receipts through publish sync', () => {
    const root = makeRepo();
    const stem = 'sync-draft';
    const draftPath = writeDraft(root, stem);
    const reviewDir = writeReceipt(root, stem, [
      receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency'),
      receiptEntry('finding-ledger', 'scope-violation', 'scope-violation'),
    ]);
    writeFileSync(
      join(reviewDir, 'pass-01-architectural.capture.txt'),
      'Reviewer prose says this draft has a scope-violation false positive.',
    );
    writeFileSync(join(reviewDir, 'finding-disposition-ledger.json'), '{"findings":[]}');

    const tier = validateTierGateGuardReceipt(draftText(), draftPath);
    const ledger = validateFindingLedgerGuardReceipt(draftText(), draftPath);
    expect(tier.ok).toBe(true);
    expect(ledger.ok).toBe(true);

    const result = syncPublishIssueBody(
      {
        runGh(argv: string[]) {
          if (argv[1] === 'api') {
            return {
              exitCode: 0,
              stdout: draftText().replace(/^#[^\n]*\n\n/, ''),
              stderr: '',
            };
          }
          return {
            exitCode: 0,
            stdout: 'https://github.com/owner/repo/issues/781\n',
            stderr: '',
          };
        },
        writeBodyFile() {
          return join(root, 'body.md');
        },
        emitAudit() {},
      },
      {
        mode: 'create',
        draftPath,
        draftContent: draftText(),
        repo: 'owner/repo',
        title: 'Receipt fixture',
      },
    );
    expect(result.ok).toBe(true);
  });

  it('fails closed when captures exist but the finding ledger is missing', () => {
    const root = makeRepo();
    const stem = 'sync-draft-missing-ledger';
    const draftPath = writeDraft(root, stem);
    const reviewDir = writeReceipt(root, stem, [
      receiptEntry('tier-marker', 'concurrency-state-retry', 'concurrency'),
    ]);
    writeFileSync(
      join(reviewDir, 'pass-01-architectural.capture.txt'),
      'Reviewer prose says this draft has a scope-violation false positive.',
    );

    const ledger = validateFindingLedgerGuardReceipt(draftText(), draftPath);
    expect(ledger.ok).toBe(false);
    expect(ledger.message).toContain('missing finding-disposition-ledger.json');

    const result = syncPublishIssueBody(
      {
        runGh() {
          throw new Error('sync should stop before calling gh');
        },
        writeBodyFile() {
          return join(root, 'body.md');
        },
        emitAudit() {},
      },
      {
        mode: 'create',
        draftPath,
        draftContent: draftText(),
        repo: 'owner/repo',
        title: 'Receipt fixture',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('missing finding-disposition-ledger.json');
    }
  });
});
