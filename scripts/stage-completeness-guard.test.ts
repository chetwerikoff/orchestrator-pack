import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
  parseCompetitiveWaiver,
} from './lib/stage-completeness-core.ts';
import { runCli } from './stage-completeness-guard.ts';

const roots: string[] = [];

function draftText(tier: 'T1' | 'T2' | 'T3' = 'T3'): string {
  return [
    '# test draft',
    '',
    '```complexity-tier',
    `tier: ${tier}`,
    `advisory-prior: ${tier}`,
    '```',
    '',
  ].join('\n');
}

function makeCase(
  name: string,
  options: {
    tier?: 'T1' | 'T2' | 'T3';
    captures?: Record<string, string>;
    waiver?: unknown;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'stage-completeness-'));
  roots.push(root);
  const draftsDir = join(root, 'docs/issues_drafts');
  const reviewDir = join(draftsDir, '.review', name);
  mkdirSync(reviewDir, { recursive: true });
  const target = join(draftsDir, `${name}.md`);
  writeFileSync(target, draftText(options.tier ?? 'T3'), 'utf8');
  for (const [fileName, body] of Object.entries(options.captures ?? {})) {
    writeFileSync(join(reviewDir, fileName), body, 'utf8');
  }
  if (options.waiver !== undefined) {
    writeFileSync(join(reviewDir, 'competitive-stage-waiver.json'), JSON.stringify(options.waiver), 'utf8');
  }
  return {
    root,
    target,
    reviewDir,
    check: () => checkStageCompletenessGuard(readFileSync(target, 'utf8'), { repoRoot: root, draftPath: target }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('stage-completeness terminal GPT topology', () => {
  it('accepts competitive -> architect-lens -> terminal architectural without architectural-final', () => {
    const testCase = makeCase('conforming-terminal-gpt', {
      captures: {
        'pass-01-competitive.capture.txt': 'competitive',
        'pass-02-architectural-lens.capture.txt': 'claude lens',
        'pass-03-architectural.capture.txt': 'terminal gpt',
      },
    });
    const result = testCase.check();
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.receipt).toEqual({
      tier: 'T3',
      competitiveAnchor: 1,
      lensMax: 2,
      finalPass: 3,
    });
  });

  it('rejects the landed r03 order with architectural before architect-lens', () => {
    const testCase = makeCase('old-r03-order', {
      captures: {
        'pass-01-competitive.capture.txt': 'competitive',
        'pass-02-architectural.capture.txt': 'old pre-lens gpt',
        'pass-03-architectural-lens.capture.txt': 'claude lens',
        'pass-04-architectural-final.capture.txt': 'old final stage',
      },
    });
    const result = testCase.check();
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'terminal architectural must be strictly after architect-lens',
    );
  });

  it('requires a terminal architectural capture after the lens', () => {
    const testCase = makeCase('missing-terminal-gpt', {
      captures: {
        'pass-01-competitive.capture.txt': 'competitive',
        'pass-02-architectural-lens.capture.txt': 'claude lens',
        'pass-03-architectural-final.capture.txt': 'historical final only',
      },
    });
    const result = testCase.check();
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing architectural stage');
  });

  it('allows only one terminal architectural pass after the lens', () => {
    const testCase = makeCase('terminal-ceiling', {
      captures: {
        'pass-01-competitive.capture.txt': 'competitive',
        'pass-02-architectural-lens.capture.txt': 'claude lens',
        'pass-03-architectural.capture.txt': 'terminal gpt one',
        'pass-04-architectural.capture.txt': 'terminal gpt two',
      },
    });
    const result = testCase.check();
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'architectural stage ceiling exceeded (exactly one terminal pass allowed after architect-lens)',
    );
  });

  it('still requires architect-lens strictly after the competitive anchor', () => {
    const missingLens = makeCase('missing-lens', {
      captures: {
        'pass-01-competitive.capture.txt': 'competitive',
        'pass-02-architectural.capture.txt': 'architectural',
      },
    }).check();
    expect(missingLens.ok).toBe(false);
    expect(missingLens.errors.join('\n')).toContain('missing architect-lens stage');

    const wrongOrder = makeCase('lens-before-competitive', {
      captures: {
        'pass-01-architectural-lens.capture.txt': 'claude lens',
        'pass-02-competitive.capture.txt': 'competitive',
        'pass-03-architectural.capture.txt': 'terminal gpt',
      },
    }).check();
    expect(wrongOrder.ok).toBe(false);
    expect(wrongOrder.errors.join('\n')).toContain(
      'architect-lens stage out of order (must be strictly after competitive anchor)',
    );
  });

  it('does not require architectural-final and ignores historical final bytes for current terminal selection', () => {
    const testCase = makeCase('historical-final-tolerated', {
      captures: {
        'pass-01-competitive.capture.txt': 'competitive',
        'pass-02-architectural-lens.capture.txt': 'claude lens',
        'pass-03-architectural.capture.txt': 'terminal gpt',
        'pass-04-architectural-final.capture.txt': 'historical audit bytes',
      },
    });
    const result = testCase.check();
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.receipt?.finalPass).toBe(3);
  });
});

describe('stage-completeness competitive waiver compatibility', () => {
  const recordedAt = '2026-07-28T00:00:00.000Z';

  it('keeps operator-waiver credit with the new lens -> terminal GPT order', () => {
    const testCase = makeCase('operator-waiver', {
      waiver: { reason: 'operator-waiver', 'recorded-at': recordedAt, 'after-pass': 0 },
      captures: {
        'pass-01-architectural-lens.capture.txt': 'claude lens',
        'pass-02-architectural.capture.txt': 'terminal gpt',
      },
    });
    const result = testCase.check();
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.receipt?.competitiveAnchor).toBe(0);
  });

  it('keeps codex-substitution parseable as historical bytes but grants no stage credit', () => {
    const testCase = makeCase('codex-substitution-waiver', {
      waiver: { reason: 'codex-substitution', 'recorded-at': recordedAt, 'after-pass': 0 },
      captures: {
        'pass-01-architectural-lens.capture.txt': 'claude lens',
        'pass-02-architectural.capture.txt': 'terminal gpt',
      },
    });
    const parsed = parseCompetitiveWaiver(testCase.reviewDir);
    expect(parsed.invalid).toBe(false);
    expect(parsed.waiver?.reason).toBe('codex-substitution');
    const result = testCase.check();
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing competitive stage');
  });

  it('strictly validates waiver timestamp and after-pass fields', () => {
    const testCase = makeCase('waiver-shape');
    const cases = [
      { reason: 'operator-waiver', 'recorded-at': '2026-07-28', 'after-pass': 0 },
      { reason: 'operator-waiver', 'recorded-at': recordedAt, 'after-pass': null },
      { reason: 'operator-waiver', 'recorded-at': recordedAt, 'after-pass': '0' },
      { reason: 'operator-waiver', 'recorded-at': recordedAt, 'after-pass': false },
    ];
    for (const value of cases) {
      writeFileSync(join(testCase.reviewDir, 'competitive-stage-waiver.json'), JSON.stringify(value), 'utf8');
      const parsed = parseCompetitiveWaiver(testCase.reviewDir);
      expect(parsed.waiver).toBeNull();
      expect(parsed.invalid).toBe(true);
    }
  });
});

describe('stage-completeness compatibility floors', () => {
  it('remains a no-op for T1 and T2', () => {
    for (const tier of ['T1', 'T2'] as const) {
      const result = makeCase(`noop-${tier}`, { tier }).check();
      expect(result.ok).toBe(true);
      expect(result.noop).toBe(true);
    }
  });

  it('preserves the existing grandfather exception', () => {
    const result = makeCase('206-ao-010-session-status-readers-migration').check();
    expect(result.ok).toBe(true);
    expect(result.receipt).toBeNull();
  });

  it('still rejects empty and malformed counted captures', () => {
    const empty = makeCase('empty-capture', {
      captures: {
        'pass-01-competitive.capture.txt': '   ',
        'pass-02-architectural-lens.capture.txt': 'claude lens',
        'pass-03-architectural.capture.txt': 'terminal gpt',
      },
    }).check();
    expect(empty.ok).toBe(false);
    expect(empty.errors.join('\n')).toContain('empty capture file');

    const malformed = makeCase('malformed-capture', {
      captures: {
        'competitive.capture.txt': 'competitive',
        'pass-02-architectural-lens.capture.txt': 'claude lens',
        'pass-03-architectural.capture.txt': 'terminal gpt',
      },
    }).check();
    expect(malformed.ok).toBe(false);
    expect(malformed.errors.join('\n')).toContain(
      'unparseable capture filename: competitive.capture.txt',
    );
  });

  it('emits the existing receipt shape with final-pass bound to terminal architectural', () => {
    const testCase = makeCase('receipt', {
      captures: {
        'pass-04-competitive.capture.txt': 'competitive',
        'pass-05-architectural-lens.capture.txt': 'claude lens',
        'pass-06-architectural.capture.txt': 'terminal gpt',
      },
    });
    const result = testCase.check();
    expect(result.ok, result.errors.join('\n')).toBe(true);
    const message = formatStageCompletenessPassMessage(result);
    expect(message).toContain('tier=T3');
    expect(message).toContain('competitive-anchor=4');
    expect(message).toContain('lens-max=5');
    expect(message).toContain('final-pass=6');
    expect(
      runCli([
        'node',
        'stage-completeness-guard.ts',
        '--text-file',
        testCase.target,
        '--draft-path',
        testCase.target,
        '--repo-root',
        testCase.root,
      ]),
    ).toBe(0);
  });
});
