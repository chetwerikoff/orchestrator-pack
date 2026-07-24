import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard } from './finding-ledger-guard.mjs';

type Capture = { name: string; timestampMs: number; text: string };

type Row = Record<string, unknown> & {
  id: string;
  summary?: string;
  type?: string;
  disposition?: 'addressed' | 'rejected';
};

const adoption = 1_000;

function markedFinding(
  id: string,
  options: {
    type?: string;
    evidence?: string;
    recommendation?: string;
    persistent?: 'yes' | 'no' | '';
    price?: boolean;
    candidate?: string | null;
    clean?: boolean;
  } = {},
): string {
  const type = options.type ?? 'quality';
  const evidence = options.evidence ?? 'Observable contract is violated.';
  const recommendation = options.recommendation ?? 'Use the cheapest sufficient correction.';
  const persistent = options.persistent === undefined ? 'no' : options.persistent;
  const lines = [
    'review-economics-contract: v1',
    `id: ${id}`,
    `type: ${type}`,
    'severity: P1',
    `evidence: ${evidence}`,
    `recommendation: ${recommendation}`,
  ];
  if (persistent !== '') lines.push(`persistent-machinery: ${persistent}`);
  if (persistent === 'yes' && options.price !== false) {
    lines.push('cheapest-sufficient-alternative: no-build is insufficient; reuse the existing guard');
    lines.push('stakes-price: Goal system guarantee');
    lines.push('trade-in: net-add');
  }
  if (options.candidate !== null && options.candidate !== undefined) {
    lines.push(`simplification-cut-candidate: ${options.candidate}`);
  }
  if (options.clean ?? options.candidate == null) lines.push('SIMPLIFICATION_CLEAN');
  return lines.join('\n');
}

function markedClean(): string {
  return ['review-economics-contract: v1', 'NO_FINDINGS', 'SIMPLIFICATION_CLEAN'].join('\n');
}

function row(id: string, overrides: Partial<Row> & Record<string, unknown> = {}): Row {
  return {
    id,
    summary: `summary ${id}`,
    type: 'quality',
    disposition: 'addressed',
    'persistent-machinery': 'no',
    'simplification-cut-candidate': false,
    ...overrides,
  };
}

function run(
  captures: Capture[],
  rows: Row[],
  options: Record<string, unknown> = {},
) {
  return checkFindingLedgerGuard(
    captures.map((capture) => capture.text),
    JSON.stringify({ version: 1, findings: rows }),
    {
      phase: 'pre-lens',
      adoptionTimestampMs: adoption,
      issueRevision: 'r3',
      stageTerminalConfirmed: true,
      captureMetadata: captures.map(({ name, timestampMs }) => ({ name, timestampMs })),
      ...options,
    } as never,
  );
}

function finalRun(captures: Capture[], rows: Row[], options: Record<string, unknown> = {}) {
  return run(captures, rows, { phase: 'final-acceptance', ...options });
}

function cap(name: string, timestampMs: number, text: string): Capture {
  return { name, timestampMs, text };
}

const authorActivation = {
  authority: 'author',
  signal: 'The changed path is out of scope under allowed_roots.',
  whyNow: 'The task must close its own scope violation before acceptance.',
};

function currentLens(
  id: string,
  options: {
    revision?: string;
    contest?: 'none' | 'contested' | 'contest-withdrawn';
    outcome?: 'none' | 'activate' | 'non-activate';
    evidence?: string;
    whyNow?: string;
  } = {},
) {
  return [
    `m3-protected: id=${id}`,
    `revision=${options.revision ?? 'r3'}`,
    `contest=${options.contest ?? 'none'}`,
    `outcome=${options.outcome ?? 'none'}`,
    `evidence=${options.evidence ?? ''}`,
    `why-now=${options.whyNow ?? ''}`,
  ].join(' | ');
}

describe('finding ledger review economics #975', () => {
  it('validates finding-bearing and clean raw Codex economics before transcription', () => {
    const result = run(
      [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
      [],
      {
        rawCodexResults: [
          {
            reviewEconomicsContract: 'v1',
            findings: [
              {
                id: 'CX1',
                type: 'quality',
                evidence: 'A persistent registry would duplicate existing state.',
                recommendation: 'Reuse the existing audit plane.',
                persistentMachinery: 'yes',
                cheapestSufficientAlternative: 'reuse the existing audit plane',
                stakesPrice: 'Goal bounded blast radius',
                tradeIn: 'net-add',
                simplificationCutCandidate: 'yes',
              },
            ],
          },
          {
            reviewEconomicsContract: 'v1',
            findings: [],
            terminalTokens: ['NO_FINDINGS', 'SIMPLIFICATION_CLEAN'],
          },
        ],
      },
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  describe('M2 adoption cutover and marker continuity', () => {
    it('allows immutable unmarked pre-adoption capture followed by marked post-adoption reviewer', () => {
      const result = run(
        [
          cap('pass-01-architectural.capture.txt', 500, 'id: OLD\ntype: quality\nOld finding.'),
          cap('pass-02-architectural.capture.txt', 1_100, markedClean()),
        ],
        [row('OLD')],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('does not let a pre-adoption marker self-elect M2 authority', () => {
      const result = run(
        [
          cap('pass-01-architectural.capture.txt', 500, markedFinding('OLD', { persistent: '' })),
          cap('pass-02-architectural.capture.txt', 1_100, markedClean()),
        ],
        [row('OLD')],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('fails an unmarked post-adoption reviewer even when a later marker exists', () => {
      const result = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, 'NO_FINDINGS'),
          cap('pass-02-architectural.capture.txt', 1_200, markedClean()),
        ],
        [],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('post-adoption reviewer capture pass-01-architectural.capture.txt missing');
    });

    it('excludes architect-lens from reviewer marker continuity', () => {
      const result = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'architect lens evidence without reviewer marker'),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });
  });

  describe('M2 stable defect identity and structural gate', () => {
    it.each([
      ['yes -> no', markedFinding('F1', { persistent: 'yes' }), markedFinding('F1', { persistent: 'no' }), row('F1')],
      [
        'no -> yes',
        markedFinding('F1', { persistent: 'no' }),
        markedFinding('F1', { persistent: 'yes' }),
        row('F1', {
          'persistent-machinery': 'yes',
          'cheapest-sufficient-alternative': 'no-build is insufficient; reuse the existing guard',
          'stakes-price': 'Goal system guarantee',
          'trade-in': 'net-add',
        }),
      ],
    ])('accepts latest proposal economics for %s', (_label, first, second, ledgerRow) => {
      const result = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, first as string),
          cap('pass-02-architectural.capture.txt', 1_200, second as string),
        ],
        [ledgerRow as Row],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('fails a latest marked occurrence missing persistent-machinery', () => {
      const result = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('F1', { persistent: '' }))],
        [row('F1')],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('persistent-machinery must be yes or no');
    });

    it('fails raw/ledger persistent-machinery mismatch', () => {
      const result = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('F1', { persistent: 'no' }))],
        [row('F1', { 'persistent-machinery': 'yes' })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('ledger persistent-machinery does not match');
    });

    it('fails malformed yes pricing unless remedy is row-locally declined as malformed-proposal', () => {
      const malformed = markedFinding('F1', { persistent: 'yes', price: false });
      const failed = run(
        [cap('pass-01-architectural.capture.txt', 1_100, malformed)],
        [row('F1', { 'persistent-machinery': 'yes' })],
      );
      expect(failed.ok).toBe(false);
      expect(failed.errors.join('\n')).toContain('malformed persistent-machinery proposal');

      const declined = run(
        [cap('pass-01-architectural.capture.txt', 1_100, malformed)],
        [
          row('F1', {
            'persistent-machinery': 'yes',
            'proposal-outcome': 'declined',
            'proposal-reason': 'malformed-proposal',
          }),
        ],
      );
      expect(declined.ok, declined.errors.join('\n')).toBe(true);
    });
  });

  describe('M3 nomination, zero-signal, author activation, and architect contest', () => {
    const nonZero = markedFinding('S1', {
      type: 'scope-violation',
      evidence: 'The proposed edit is out of scope under allowed_roots.',
      recommendation: 'Remove that edit from the remedy.',
    });
    const zeroSignal = markedFinding('S1', {
      type: 'scope-violation',
      evidence: 'The proposed change has no declared path relationship.',
      recommendation: 'Add a denylist entry.',
    });

    it('scans only raw evidence: remedy-only protected words do not activate zero-signal', () => {
      const failed = run(
        [cap('pass-01-architectural.capture.txt', 1_100, zeroSignal)],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(failed.ok).toBe(false);
      expect(failed.errors.join('\n')).toContain('requires architect-pending');

      const pending = run(
        [cap('pass-01-architectural.capture.txt', 1_100, zeroSignal)],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation, architectPending: true })],
      );
      expect(pending.ok, pending.errors.join('\n')).toBe(true);
    });

    it('accepts valid author activation without architect authorization when current lens records no contest', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1')),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('contest before/after author activation remains architect-pending at final acceptance', () => {
      for (const activation of [undefined, authorActivation]) {
        const result = finalRun(
          [
            cap('pass-01-architectural.capture.txt', 1_100, nonZero),
            cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { contest: 'contested' })),
            cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
          ],
          [row('S1', { type: 'scope-violation', protectedActivation: activation, architectPending: true })],
        );
        expect(result.ok).toBe(false);
        expect(result.errors.join('\n')).toContain('architect-pending under current contest');
      }
    });

    it('contest-withdrawn restores otherwise-valid author authority', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { contest: 'contest-withdrawn' })),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it.each([
      ['stale revision', currentLens('S1', { revision: 'r2' })],
      ['unknown state', 'architect lens without an m3-protected record'],
    ])('fails closed on %s contest evidence', (_label, lensText) => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, lensText),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('unknown/stale architect contest state');
    });

    it('accepts current architect activation with real signal + why-now provenance for zero-signal nomination', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, zeroSignal),
          cap(
            'pass-02-architectural-lens.capture.txt',
            1_200,
            currentLens('S1', {
              outcome: 'activate',
              evidence: 'The changed path is out of scope under allowed_roots.',
              whyNow: 'This task owns that path change.',
            }),
          ),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation' })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('accepts architect non-activation provenance and restores ordinary M1 rejection', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, zeroSignal),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { outcome: 'non-activate' })),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', disposition: 'rejected', rejectReason: 'no real protected defect' })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('admits architect-pending at pre-lens progression but never at final acceptance', () => {
      const pendingRow = row('S1', { type: 'scope-violation', architectPending: true });
      const pre = run([cap('pass-01-architectural.capture.txt', 1_100, zeroSignal)], [pendingRow]);
      expect(pre.ok, pre.errors.join('\n')).toBe(true);

      const final = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, zeroSignal),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1')),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [pendingRow],
      );
      expect(final.ok).toBe(false);
      expect(final.errors.join('\n')).toContain('requires current architect adjudication');
    });
  });

  describe('M5 exact terminal simplification verdict', () => {
    it('requires SIMPLIFICATION_CLEAN and NO_FINDINGS for genuinely clean terminal output', () => {
      const ok = run([cap('pass-01-architectural.capture.txt', 1_100, markedClean())], []);
      expect(ok.ok, ok.errors.join('\n')).toBe(true);

      const missing = run(
        [cap('pass-01-architectural.capture.txt', 1_100, 'review-economics-contract: v1\nNO_FINDINGS')],
        [],
      );
      expect(missing.ok).toBe(false);
      expect(missing.errors.join('\n')).toContain('SIMPLIFICATION_CLEAN');
    });

    it('accepts a tokened non-clean cut candidate after ledger disposition with no retroactive clean token', () => {
      const result = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1', { candidate: 'yes', clean: false }))],
        [row('CUT1', { 'simplification-cut-candidate': true })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it.each([
      ['invalid value', 'maybe'],
      ['empty value', ''],
    ])('fails malformed cut-candidate discriminator: %s', (_label, value) => {
      const result = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1', { candidate: value, clean: false }))],
        [row('CUT1')],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('invalid simplification-cut-candidate');
    });

    it('fails duplicate cut-candidate discriminator', () => {
      const text = `${markedFinding('CUT1', { candidate: 'yes', clean: false })}\nsimplification-cut-candidate: yes`;
      const result = run(
        [cap('pass-01-architectural.capture.txt', 1_100, text)],
        [row('CUT1', { 'simplification-cut-candidate': true })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('duplicate simplification-cut-candidate');
    });

    it('tracks multiple cut candidates independently', () => {
      const first = markedFinding('CUT1', { candidate: 'yes', clean: false });
      const second = markedFinding('CUT2', { candidate: 'yes', clean: false }).replace('review-economics-contract: v1\n', '');
      const result = run(
        [cap('pass-01-architectural.capture.txt', 1_100, `${first}\n${second}`)],
        [
          row('CUT1', { 'simplification-cut-candidate': true }),
          row('CUT2', { 'simplification-cut-candidate': true }),
        ],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('fails both raw yes -> missing ledger flag and ledger flag -> no raw yes', () => {
      const rawYes = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1', { candidate: 'yes', clean: false }))],
        [row('CUT1')],
      );
      expect(rawYes.ok).toBe(false);
      expect(rawYes.errors.join('\n')).toContain('raw/ledger mismatch');

      const ledgerOnly = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1'))],
        [row('CUT1', { 'simplification-cut-candidate': true })],
      );
      expect(ledgerOnly.ok).toBe(false);
      expect(ledgerOnly.errors.join('\n')).toContain('raw/ledger mismatch');
    });

    it('does not infer a cut candidate from ordinary simplification prose', () => {
      const result = run(
        [
          cap(
            'pass-01-architectural.capture.txt',
            1_100,
            markedFinding('F1', { recommendation: 'Simplify this mechanism by deleting duplication.' }),
          ),
        ],
        [row('F1')],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });
  });

  describe('M5 adoption anchor and same-episode relens behavior', () => {
    it('rejects a pre-adoption anchor even when post-adoption architectural-final evidence exists', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 500, 'NO_FINDINGS'),
          cap('pass-02-architectural-lens.capture.txt', 700, 'first lens'),
          cap('pass-03-architectural-final.capture.txt', 1_200, markedClean()),
        ],
        [],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('pre-adoption M5 anchor cannot satisfy final acceptance');
    });

    it('accepts the same history after one governed post-adoption pre-lens re-entry supplies a new terminal anchor', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 500, 'NO_FINDINGS'),
          cap('pass-02-architectural-lens.capture.txt', 700, 'first lens'),
          cap('pass-03-architectural-final.capture.txt', 1_200, markedClean()),
          cap('pass-04-architectural.capture.txt', 1_300, markedClean()),
          cap('pass-05-architectural-lens.capture.txt', 1_400, 'new segment lens'),
          cap('pass-06-architectural-final.capture.txt', 1_500, markedClean()),
        ],
        [],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('reuses the same post-adoption M5 anchor across same-episode relenses', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'first lens'),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
          cap('pass-04-architectural-lens.capture.txt', 1_400, 'newer same-episode lens'),
          cap('pass-05-architectural-final.capture.txt', 1_500, markedClean()),
        ],
        [],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('does not require M5 clean token on post-lens architectural-final evidence', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'first lens'),
          cap('pass-03-architectural-final.capture.txt', 1_300, 'review-economics-contract: v1\nNO_FINDINGS'),
        ],
        [],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });
  });

  describe('post-final protected nomination state transitions', () => {
    it('valid author activation -> newer same-revision lens audit -> fresh final without synthetic Issue edit', () => {
      const nomination = markedFinding('PF1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural-final.capture.txt', 1_300, nomination),
          cap('pass-04-architectural-lens.capture.txt', 1_400, currentLens('PF1', { contest: 'none' })),
          cap('pass-05-architectural-final.capture.txt', 1_500, markedClean()),
        ],
        [row('PF1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('zero-signal -> architect-pending -> newer same-revision lens adjudication -> fresh final', () => {
      const nomination = markedFinding('PF1', {
        type: 'scope-violation',
        evidence: 'The proposed file relationship is unclear.',
        recommendation: 'Add a denylist rule.',
      });
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural-final.capture.txt', 1_300, nomination),
          cap(
            'pass-04-architectural-lens.capture.txt',
            1_400,
            currentLens('PF1', {
              outcome: 'activate',
              evidence: 'The proposed path is out of scope under allowed_roots.',
              whyNow: 'The current task owns the proposed path change.',
            }),
          ),
          cap('pass-05-architectural-final.capture.txt', 1_500, markedClean()),
        ],
        [row('PF1', { type: 'scope-violation' })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });
  });

  it('fails pre-lens progression when existing stage authority was not confirmed terminal', () => {
    const result = run(
      [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
      [],
      { stageTerminalConfirmed: false },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('existing stage authority');
  });
});

describe('legacy finding-ledger behavior remains default', () => {
  it('still rejects protected finding disposition rejected without #975 phase', () => {
    const result = checkFindingLedgerGuard(
      'id: LEG1\ntype: security\nsecurity issue',
      JSON.stringify({
        findings: [
          { id: 'LEG1', summary: 'legacy security', type: 'security', disposition: 'rejected', rejectReason: 'legacy reject' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('cannot be disposed rejected');
  });

  it('still accepts addressed protected legacy coverage', () => {
    const result = checkFindingLedgerGuard(
      'id: LEG1\ntype: security\nsecurity issue',
      JSON.stringify({
        findings: [
          { id: 'LEG1', summary: 'legacy security', type: 'security', disposition: 'addressed' },
        ],
      }),
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });
});