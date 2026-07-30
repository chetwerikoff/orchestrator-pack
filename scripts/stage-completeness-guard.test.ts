import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import './chatgpt-browser-turn/state-light-turn.test-support.ts';
import { normalizeConversationUrl } from './chatgpt-browser-turn/ui-adapter.ts';
import { checkFindingLedgerGuard } from './finding-ledger-guard.mjs';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
  parseArchitectLensWaiver,
  parseCompetitiveWaiver,
} from './lib/stage-completeness-core.ts';
import { runCli } from './stage-completeness-guard.ts';

vi.mocked(normalizeConversationUrl).mockReturnValue('https://chatgpt.com/c/fake-owned-turn');

const T3_DRAFT = `# T3 fixture

\`\`\`complexity-tier
tier: T3
advisory-prior: T3
\`\`\`
`;

function withCase<T>(
  files: Record<string, string>,
  run: (input: { repoRoot: string; draftPath: string; reviewDir: string }) => T,
): T {
  const repoRoot = mkdtempSync(join(tmpdir(), 'stage-completeness-1120-'));
  const draftsDir = join(repoRoot, 'docs/issues_drafts');
  const draftPath = join(draftsDir, '1120-browser-gpt.md');
  const reviewDir = join(draftsDir, '.review/1120-browser-gpt');
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(draftPath, T3_DRAFT, 'utf8');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(reviewDir, name), body, 'utf8');
  }
  try {
    return run({ repoRoot, draftPath, reviewDir });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function check(files: Record<string, string>) {
  return withCase(files, ({ repoRoot, draftPath }) => checkStageCompletenessGuard(T3_DRAFT, {
    repoRoot,
    draftPath,
  }));
}

const CONFORMING = {
  'pass-01-competitive.capture.txt': 'competitive pass',
  'pass-02-architectural-review.capture.txt': 'architectural review',
  'pass-03-architectural-lens.capture.txt': 'claude lens',
  'pass-04-architectural.capture.txt': 'terminal gpt lens',
};

const ECONOMICS_CLEAN = [
  'review-economics-contract: v1',
  'NO_FINDINGS',
  'SIMPLIFICATION_CLEAN',
].join('\n');

describe('Issue #1120 T3 four-stage completeness', () => {
  it('requires competitive -> architectural-review -> Claude lens -> GPT lens', () => {
    const result = check(CONFORMING);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.receipt).toEqual({
      tier: 'T3',
      competitiveAnchor: 1,
      architecturalReviewPass: 2,
      lensMax: 3,
      lensSkipAnchor: null,
      terminalPass: 4,
    });
    const message = formatStageCompletenessPassMessage(result);
    expect(message).toMatch(/competitive-anchor=1/);
    expect(message).toMatch(/architectural-review-pass=2/);
    expect(message).toMatch(/lens-max=3/);
    expect(message).toMatch(/terminal-pass=4/);
  });

  it('counts stage ceilings only inside the active acceptance-attempt segment', () => {
    const result = check({
      'pass-01-competitive.capture.txt': 'historical competitive',
      'pass-02-architectural-review.capture.txt': 'historical architectural review',
      'pass-03-architectural-lens.capture.txt': 'historical claude lens',
      'pass-04-architectural.capture.txt': 'historical terminal gpt lens',
      'pass-05-competitive.capture.txt': 'current competitive',
      'pass-06-architectural-review.capture.txt': 'current architectural review',
      'pass-07-architectural-lens.capture.txt': 'current claude lens',
      'pass-08-architectural.capture.txt': 'current terminal gpt lens',
    });

    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.receipt).toEqual({
      tier: 'T3',
      competitiveAnchor: 5,
      architecturalReviewPass: 6,
      lensMax: 7,
      lensSkipAnchor: null,
      terminalPass: 8,
    });
  });

  it('fails closed when architectural-review is missing, duplicated, or out of order', () => {
    const missing = check({
      'pass-01-competitive.capture.txt': 'competitive',
      'pass-02-architectural-lens.capture.txt': 'claude',
      'pass-03-architectural.capture.txt': 'terminal',
    });
    expect(missing.errors.join(' ')).toMatch(/missing architectural-review stage/);

    const duplicate = check({
      'pass-01-competitive.capture.txt': 'competitive',
      'pass-02-architectural-review.capture.txt': 'review one',
      'pass-03-architectural-review.capture.txt': 'review two',
      'pass-04-architectural-lens.capture.txt': 'claude',
      'pass-05-architectural.capture.txt': 'terminal',
    });
    expect(duplicate.errors.join(' ')).toMatch(/architectural-review stage ceiling exceeded/);

    const early = check({
      'pass-01-architectural-review.capture.txt': 'review too early',
      'pass-02-competitive.capture.txt': 'competitive',
      'pass-03-architectural-lens.capture.txt': 'claude',
      'pass-04-architectural.capture.txt': 'terminal',
    });
    expect(early.errors.join(' ')).toMatch(/architectural-review stage out of order/);
  });

  it('requires a real competitive pass and retains the three-pass ceiling', () => {
    const tooMany = check({
      'pass-01-competitive.capture.txt': 'one',
      'pass-02-competitive.capture.txt': 'two',
      'pass-03-competitive.capture.txt': 'three',
      'pass-04-competitive.capture.txt': 'four',
      'pass-05-architectural-review.capture.txt': 'review',
      'pass-06-architectural-lens.capture.txt': 'claude',
      'pass-07-architectural.capture.txt': 'terminal',
    });
    expect(tooMany.errors.join(' ')).toMatch(/competitive stage ceiling exceeded/);

    const waived = withCase({
      'competitive-stage-waiver.json': JSON.stringify({
        reason: 'operator-waiver',
        'recorded-at': '2026-07-29T00:00:00.000Z',
        'after-pass': 0,
      }),
      'pass-01-architectural-review.capture.txt': 'review',
      'pass-02-architectural-lens.capture.txt': 'claude',
      'pass-03-architectural.capture.txt': 'terminal',
    }, ({ repoRoot, draftPath, reviewDir }) => ({
      parsed: parseCompetitiveWaiver(reviewDir),
      result: checkStageCompletenessGuard(T3_DRAFT, { repoRoot, draftPath }),
    }));
    expect(waived.parsed.waiver?.reason).toBe('operator-waiver');
    expect(waived.result.errors.join(' ')).toMatch(/missing competitive stage/);
  });

  it('accepts only the existing explicit Claude-unavailable waiver after architectural-review', () => {
    const outcome = withCase({
      'pass-01-competitive.capture.txt': 'competitive',
      'pass-02-architectural-review.capture.txt': 'review',
      'architect-lens-stage-waiver.json': JSON.stringify({
        reason: 'claude-unavailable',
        'recorded-at': '2026-07-29T00:00:00.000Z',
        'after-pass': 3,
        unavailability: 'provider-unavailable',
      }),
      'pass-04-architectural.capture.txt': 'terminal',
    }, ({ repoRoot, draftPath, reviewDir }) => ({
      parsed: parseArchitectLensWaiver(reviewDir),
      result: checkStageCompletenessGuard(T3_DRAFT, { repoRoot, draftPath }),
    }));
    expect(outcome.parsed.waiver?.reason).toBe('claude-unavailable');
    expect(outcome.result.ok, outcome.result.errors.join('\n')).toBe(true);
    expect(outcome.result.receipt?.lensSkipAnchor).toBe(3);
  });

  it('keeps historical architectural-final captures audit-only while rejecting bad current ordering', () => {
    const baseline = check(CONFORMING);
    const historical = check({ ...CONFORMING, 'pass-05-architectural-final.capture.txt': 'obsolete audit evidence' });
    expect(baseline.ok, baseline.errors.join('\n')).toBe(true);
    expect(historical.ok, historical.errors.join('\n')).toBe(true);
    expect(historical.receipt).toEqual(baseline.receipt);

    const lensEarly = check({
      'pass-01-competitive.capture.txt': 'competitive',
      'pass-02-architectural-lens.capture.txt': 'claude too early',
      'pass-03-architectural-review.capture.txt': 'review',
      'pass-04-architectural.capture.txt': 'terminal',
    });
    expect(lensEarly.errors.join(' ')).toMatch(/architect-lens stage out of order/);

    const t2 = T3_DRAFT.replace('tier: T3', 'tier: T2').replace('advisory-prior: T3', 'advisory-prior: T2');
    const t2Result = checkStageCompletenessGuard(t2, {});
    expect(t2Result.ok).toBe(true);
    expect(t2Result.noop).toBe(true);
  });

  it('preserves the grandfathered review-dir carve-out and CLI receipt', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'stage-completeness-grandfather-'));
    const draftsDir = join(repoRoot, 'docs/issues_drafts');
    const draftPath = join(draftsDir, '206-ao-010-session-status-readers-migration.md');
    mkdirSync(join(draftsDir, '.review/206-ao-010-session-status-readers-migration'), { recursive: true });
    writeFileSync(draftPath, T3_DRAFT, 'utf8');
    try {
      const grandfathered = checkStageCompletenessGuard(T3_DRAFT, { repoRoot, draftPath });
      expect(grandfathered.ok).toBe(true);
      expect(grandfathered.receipt).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }

    const code = withCase(CONFORMING, ({ repoRoot: root, draftPath: draft }) => runCli([
      'node',
      'stage-completeness-guard.ts',
      '--text-file', draft,
      '--draft-path', draft,
      '--repo-root', root,
    ]));
    expect(code).toBe(0);
  });
});

describe('Issue #1120 architectural-review economics', () => {
  const emptyLedger = JSON.stringify({ version: 1, findings: [] });
  const baseOptions = {
    phase: 'pre-lens',
    reviewEconomics: true,
    stageTerminalConfirmed: true,
    adoptionTimestampMs: 1,
    enforceT3PreLensTopology: true,
  } as const;

  it('treats architectural-review as the governed pre-lens reviewer anchor', () => {
    const result = checkFindingLedgerGuard([ECONOMICS_CLEAN, ECONOMICS_CLEAN], emptyLedger, {
      ...baseOptions,
      captureMetadata: [
        { name: 'pass-01-competitive.capture.txt', timestampMs: 2 },
        { name: 'pass-02-architectural-review.capture.txt', timestampMs: 3 },
      ],
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('uses only the current acceptance-attempt segment for the pre-lens topology', () => {
    const captures = [
      ECONOMICS_CLEAN,
      ECONOMICS_CLEAN,
      'historical claude',
      ECONOMICS_CLEAN,
      ECONOMICS_CLEAN,
      ECONOMICS_CLEAN,
    ];
    const result = checkFindingLedgerGuard(captures, emptyLedger, {
      ...baseOptions,
      captureMetadata: [
        { name: 'pass-01-competitive.capture.txt', timestampMs: 2 },
        { name: 'pass-02-architectural-review.capture.txt', timestampMs: 3 },
        { name: 'pass-03-architectural-lens.capture.txt', timestampMs: 4 },
        { name: 'pass-04-architectural.capture.txt', timestampMs: 5 },
        { name: 'pass-05-competitive.capture.txt', timestampMs: 6 },
        { name: 'pass-06-architectural-review.capture.txt', timestampMs: 7 },
      ],
    });
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('rejects pre-lens progression without architectural-review', () => {
    const result = checkFindingLedgerGuard([ECONOMICS_CLEAN], emptyLedger, {
      ...baseOptions,
      captureMetadata: [
        { name: 'pass-01-competitive.capture.txt', timestampMs: 2 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/requires exactly one current-segment architectural-review capture/);
  });

  it('rejects terminal architectural as pre-lens authority before Claude', () => {
    const result = checkFindingLedgerGuard([ECONOMICS_CLEAN, ECONOMICS_CLEAN], emptyLedger, {
      ...baseOptions,
      captureMetadata: [
        { name: 'pass-01-competitive.capture.txt', timestampMs: 2 },
        { name: 'pass-02-architectural.capture.txt', timestampMs: 3 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/terminal architectural cannot satisfy pre-lens authority before Claude/);
    expect(result.errors.join(' ')).toMatch(/requires exactly one current-segment architectural-review capture/);
  });

  it('fails when architectural-review omits the economics marker', () => {
    const result = checkFindingLedgerGuard([ECONOMICS_CLEAN, 'NO_FINDINGS\nSIMPLIFICATION_CLEAN'], emptyLedger, {
      ...baseOptions,
      captureMetadata: [
        { name: 'pass-01-competitive.capture.txt', timestampMs: 2 },
        { name: 'pass-02-architectural-review.capture.txt', timestampMs: 3 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/pass-02-architectural-review\.capture\.txt missing review-economics-contract: v1/);
  });
});

describe('Issue #1120 state-light Browser-GPT turn', () => {
  const helperSource = readFileSync(
    resolve(process.cwd(), 'scripts/chatgpt-browser-turn/state-light-turn.ts'),
    'utf8',
  );

  it('accepts page-only final output, but not generating or foreign activity', async () => {
    const { classifyPageObservation } = await import('./chatgpt-browser-turn/state-light-turn.ts');
    expect(classifyPageObservation([
      { role: 'user', text: 'old prompt' },
      { role: 'assistant', text: 'old answer' },
      { role: 'user', text: 'review PR 1120' },
      { role: 'assistant', text: 'progress' },
      { role: 'assistant', text: 'NO_FINDINGS' },
    ], 2, 'review PR 1120', false)).toEqual({ state: 'ready', reply: 'NO_FINDINGS' });

    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'partial' },
    ], 0, 'task', true)).toEqual({ state: 'waiting' });

    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'partial' },
      { role: 'user', text: 'foreign task' },
      { role: 'assistant', text: 'foreign answer' },
    ], 0, 'task', false)).toEqual({
      state: 'foreign_suspect',
      cause: 'foreign_user_after_owned_send',
      suspectFingerprint: 'foreign task',
    });
  });

  it('does not claim an unattributed assistant node before its own prompt appears', async () => {
    const { classifyPageObservation } = await import('./chatgpt-browser-turn/state-light-turn.ts');
    expect(classifyPageObservation([
      { role: 'user', text: 'old prompt' },
      { role: 'assistant', text: 'old answer' },
      { role: 'assistant', text: 'unattributed text' },
    ], 2, 'new prompt', false)).toEqual({ state: 'waiting' });
  });

  it('contains no old admission authority, second monitor, or journal read path', () => {
    for (const forbidden of [
      'acquireDomainLock(',
      'reserveDestination(',
      'blockerBeforeSend(',
      'statusList(',
      'capabilityStatus(',
      'runtimeWitnessSurfaceAvailable(',
      'runGateBCharacterization(',
      "cause: 'reply_finished_terminal_unproven'",
    ]) expect(helperSource, forbidden).not.toContain(forbidden);
    expect(helperSource).not.toMatch(/browser-gpt-inspect|15\s*minute|10\s*minute|watchdog/i);
    expect(helperSource).toContain('contexts[0].newPage()');
    expect(helperSource.match(/sendButton\.click\(/g) ?? []).toHaveLength(1);
    expect(helperSource.match(/composer\.press\('Enter'/g) ?? []).toHaveLength(1);
    expect(helperSource).toContain('sendCount += 1');
    expect(helperSource).toContain('appendFileSync(BROWSER_TURN_RECURRENCE_PATH');
    expect(helperSource).not.toMatch(/readFileSync\(BROWSER_TURN_RECURRENCE_PATH/);
    expect(helperSource).not.toMatch(/acquire.*journal|journal.*lock/i);
    expect(helperSource).not.toContain("incident('waiting'");
    expect(helperSource).not.toContain("incident('generating'");
  });
});
