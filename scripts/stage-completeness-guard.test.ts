import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyPageObservation } from './browser-gpt-turn.ts';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
  parseArchitectLensWaiver,
  parseCompetitiveWaiver,
} from './lib/stage-completeness-core.ts';
import { runCli } from './stage-completeness-guard.ts';

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

  it('fails when architectural-review is missing', () => {
    const result = check({
      'pass-01-competitive.capture.txt': 'competitive pass',
      'pass-02-architectural-lens.capture.txt': 'claude lens',
      'pass-03-architectural.capture.txt': 'terminal gpt lens',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/missing architectural-review stage/);
  });

  it('enforces exactly one architectural-review capture per segment', () => {
    const result = check({
      'pass-01-competitive.capture.txt': 'competitive pass',
      'pass-02-architectural-review.capture.txt': 'first review',
      'pass-03-architectural-review.capture.txt': 'second review',
      'pass-04-architectural-lens.capture.txt': 'claude lens',
      'pass-05-architectural.capture.txt': 'terminal gpt lens',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/architectural-review stage ceiling exceeded/);
  });

  it('rejects architectural-review before the competitive anchor', () => {
    const result = check({
      'pass-01-architectural-review.capture.txt': 'review too early',
      'pass-02-competitive.capture.txt': 'competitive pass',
      'pass-03-architectural-lens.capture.txt': 'claude lens',
      'pass-04-architectural.capture.txt': 'terminal gpt lens',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/architectural-review stage out of order/);
  });

  it('retains the three-pass competitive ceiling and requires a real competitive pass', () => {
    const tooMany = check({
      'pass-01-competitive.capture.txt': 'one',
      'pass-02-competitive.capture.txt': 'two',
      'pass-03-competitive.capture.txt': 'three',
      'pass-04-competitive.capture.txt': 'four',
      'pass-05-architectural-review.capture.txt': 'review',
      'pass-06-architectural-lens.capture.txt': 'claude lens',
      'pass-07-architectural.capture.txt': 'terminal',
    });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.errors.join(' ')).toMatch(/competitive stage ceiling exceeded/);

    const waived = withCase({
      'competitive-stage-waiver.json': JSON.stringify({
        reason: 'operator-waiver',
        'recorded-at': '2026-07-29T00:00:00.000Z',
        'after-pass': 0,
      }),
      'pass-01-architectural-review.capture.txt': 'review',
      'pass-02-architectural-lens.capture.txt': 'claude lens',
      'pass-03-architectural.capture.txt': 'terminal',
    }, ({ repoRoot, draftPath, reviewDir }) => ({
      parsed: parseCompetitiveWaiver(reviewDir),
      result: checkStageCompletenessGuard(T3_DRAFT, { repoRoot, draftPath }),
    }));
    expect(waived.parsed.waiver?.reason).toBe('operator-waiver');
    expect(waived.result.ok).toBe(false);
    expect(waived.result.errors.join(' ')).toMatch(/missing competitive stage/);
  });

  it('supports only the existing explicit Claude-unavailable waiver between review and GPT lens', () => {
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
    expect(outcome.result.receipt?.lensMax).toBeNull();
    expect(outcome.result.receipt?.lensSkipAnchor).toBe(3);
    expect(outcome.result.receipt?.terminalPass).toBe(4);
  });

  it('rejects Claude lens before architectural-review and terminal GPT before Claude', () => {
    const lensEarly = check({
      'pass-01-competitive.capture.txt': 'competitive',
      'pass-02-architectural-lens.capture.txt': 'claude too early',
      'pass-03-architectural-review.capture.txt': 'review',
      'pass-04-architectural.capture.txt': 'terminal',
    });
    expect(lensEarly.ok).toBe(false);
    expect(lensEarly.errors.join(' ')).toMatch(/architect-lens stage out of order/);

    const terminalEarly = check({
      'pass-01-competitive.capture.txt': 'competitive',
      'pass-02-architectural-review.capture.txt': 'review',
      'pass-03-architectural.capture.txt': 'terminal too early',
      'pass-04-architectural-lens.capture.txt': 'claude lens',
    });
    expect(terminalEarly.ok).toBe(false);
    expect(terminalEarly.errors.join(' ')).toMatch(/terminal GPT capture out of order/);
  });

  it('rejects revived architectural-final capture identities', () => {
    const result = check({
      ...CONFORMING,
      'pass-05-architectural-final.capture.txt': 'obsolete identity',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unparseable capture filename: pass-05-architectural-final/);
  });

  it('keeps T1/T2 outside the T3 stage guard', () => {
    const t2 = T3_DRAFT.replace('tier: T3', 'tier: T2').replace('advisory-prior: T3', 'advisory-prior: T2');
    const result = checkStageCompletenessGuard(t2, {});
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
  });

  it('preserves the grandfathered review-dir carve-out only', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'stage-completeness-grandfather-'));
    const draftsDir = join(repoRoot, 'docs/issues_drafts');
    const draftPath = join(draftsDir, '206-ao-010-session-status-readers-migration.md');
    mkdirSync(join(draftsDir, '.review/206-ao-010-session-status-readers-migration'), { recursive: true });
    writeFileSync(draftPath, T3_DRAFT, 'utf8');
    try {
      const result = checkStageCompletenessGuard(T3_DRAFT, { repoRoot, draftPath });
      expect(result.ok).toBe(true);
      expect(result.receipt).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('emits the four-stage receipt through the CLI', () => {
    const code = withCase(CONFORMING, ({ repoRoot, draftPath }) => runCli([
      'node',
      'stage-completeness-guard.ts',
      '--text-file', draftPath,
      '--draft-path', draftPath,
      '--repo-root', repoRoot,
    ]));
    expect(code).toBe(0);
  });
});

describe('Issue #1120 state-light Browser-GPT turn', () => {
  const helperSource = readFileSync(resolve(process.cwd(), 'scripts/browser-gpt-turn.ts'), 'utf8');

  it('accepts one final page reply without service-terminal evidence', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'old prompt' },
      { role: 'assistant', text: 'old answer' },
      { role: 'user', text: 'review PR 1120' },
      { role: 'assistant', text: 'final answer' },
    ], 2, 'review PR 1120', false)).toEqual({ state: 'ready', reply: 'final answer' });
  });

  it('returns only the last assistant node for multi-node same-turn output', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'progress one' },
      { role: 'assistant', text: 'progress two' },
      { role: 'assistant', text: 'NO_FINDINGS' },
    ], 0, 'task', false)).toEqual({ state: 'ready', reply: 'NO_FINDINGS' });
  });

  it('keeps an intermediate non-empty reply waiting while generation is active', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'partial answer' },
    ], 0, 'task', true)).toEqual({ state: 'waiting' });
  });

  it('degrades only the invocation on foreign/interleaved user activity', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'partial' },
      { role: 'user', text: 'foreign task' },
      { role: 'assistant', text: 'foreign answer' },
    ], 0, 'task', false)).toEqual({
      state: 'foreign_activity',
      cause: 'foreign_or_ambiguous_user_activity',
    });
  });

  it('does not claim a reply until its own prompt appears after the baseline', () => {
    expect(classifyPageObservation([
      { role: 'user', text: 'old prompt' },
      { role: 'assistant', text: 'old answer' },
      { role: 'assistant', text: 'unattributed text' },
    ], 2, 'new prompt', false)).toEqual({ state: 'waiting' });
  });

  it('contains no old create/review admission authority or second monitor', () => {
    for (const forbidden of [
      'acquireDomainLock(',
      'reserveDestination(',
      'blockerBeforeSend(',
      'statusList(',
      'capabilityStatus(',
      'runtimeWitnessSurfaceAvailable(',
      'runGateBCharacterization(',
      "cause: 'reply_finished_terminal_unproven'",
    ]) {
      expect(helperSource, forbidden).not.toContain(forbidden);
    }
    expect(helperSource).not.toMatch(/browser-gpt-inspect|15\s*minute|10\s*minute|watchdog/i);
  });

  it('opens a dedicated tab, sends through one mutation branch, and keeps recurrence advisory', () => {
    expect(helperSource).toContain('contexts[0].newPage()');
    expect(helperSource).not.toContain('ctx.pages().find');
    expect(helperSource.match(/sendButton\.click\(/g) ?? []).toHaveLength(1);
    expect(helperSource.match(/composer\.press\('Enter'/g) ?? []).toHaveLength(1);
    expect(helperSource).toContain('sendCount = 1');
    expect(helperSource).toContain('appendFileSync(BROWSER_TURN_RECURRENCE_PATH');
    expect(helperSource).not.toMatch(/readFileSync\(BROWSER_TURN_RECURRENCE_PATH/);
    expect(helperSource).not.toMatch(/acquire.*journal|journal.*lock/i);
    expect(helperSource).not.toContain("incident('waiting'");
    expect(helperSource).not.toContain("incident('generating'");
  });
});
