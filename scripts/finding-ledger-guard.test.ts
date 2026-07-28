import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard, runCli } from './finding-ledger-guard.mjs';

type Capture = { name: string; timestampMs: number; text: string };
type Row = Record<string, unknown> & {
  id: string;
  summary?: string;
  type?: string;
  disposition?: 'addressed' | 'rejected';
};

type RawFindingOptions = {
  id?: string;
  type?: string;
  evidence?: string;
  persistent?: 'yes' | 'no' | 'true' | '';
  price?: boolean;
  candidate?: string | null;
  recommendation?: string;
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

function run(captures: Capture[], rows: Row[], options: Record<string, unknown> = {}) {
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

function rawFinding(options: RawFindingOptions = {}) {
  const id = options.id ?? 'CX1';
  const type = options.type ?? 'quality';
  const evidence = options.evidence ?? 'The review found a material defect.';
  const persistent = options.persistent ?? 'no';
  const lines = [
    `id: ${id}`,
    `type: ${type}`,
    `evidence: ${evidence}`,
  ];
  if (persistent !== '') lines.push(`persistent-machinery: ${persistent}`);
  if (persistent === 'yes' && options.price !== false) {
    lines.push('cheapest-sufficient-alternative: reuse the existing audit plane');
    lines.push('stakes-price: stakes-undeclared');
    lines.push('trade-in: net-add');
  }
  if (options.candidate !== null && options.candidate !== undefined) {
    lines.push(`simplification-cut-candidate: ${options.candidate}`);
  }
  return {
    severity: 'high',
    title: `finding ${id}`,
    body: lines.join('\n'),
    file: 'SPEC.md',
    line_start: 1,
    line_end: 1,
    confidence: 0.95,
    recommendation: options.recommendation ?? 'Use the smallest sufficient correction.',
  };
}

function rawResult(options: {
  findings?: ReturnType<typeof rawFinding>[];
  tokens?: string[];
  marker?: boolean;
  wrapped?: boolean;
} = {}) {
  const findings = options.findings ?? [];
  const summary = [
    ...(options.marker === false ? [] : ['review-economics-contract: v1']),
    ...(options.tokens ?? []),
  ].join('\n');
  const result = {
    verdict: findings.length > 0 ? 'needs-attention' : 'approve',
    summary,
    findings,
    next_steps: [] as string[],
  };
  return options.wrapped ? { result } : result;
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
  describe('real raw Codex companion validation', () => {
    it('validates finding-bearing and clean companion-schema results before transcription', () => {
      const result = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
        {
          rawCodexResults: [
            {
              stage: 'architectural',
              raw: rawResult({ findings: [rawFinding({ persistent: 'yes', candidate: 'yes' })] }),
            },
            {
              stage: 'architectural',
              raw: rawResult({ tokens: ['NO_FINDINGS', 'SIMPLIFICATION_CLEAN'], wrapped: true }),
            },
          ],
        },
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('enforces stage-specific M5 shape and exact textual candidate value', () => {
      const missingClean = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
        { rawCodexResults: [{ stage: 'architectural', raw: rawResult({ findings: [rawFinding()] }) }] },
      );
      expect(missingClean.ok).toBe(false);
      expect(missingClean.errors.join('\n')).toContain('without cut candidate must carry SIMPLIFICATION_CLEAN');

      const candidateWithClean = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
        {
          rawCodexResults: [{
            stage: 'competitive',
            raw: rawResult({ findings: [rawFinding({ candidate: 'yes' })], tokens: ['SIMPLIFICATION_CLEAN'] }),
          }],
        },
      );
      expect(candidateWithClean.ok).toBe(false);
      expect(candidateWithClean.errors.join('\n')).toContain('cannot claim SIMPLIFICATION_CLEAN');

      const booleanCandidateText = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
        {
          rawCodexResults: [{
            stage: 'architectural',
            raw: rawResult({ findings: [rawFinding({ candidate: 'true' })] }),
          }],
        },
      );
      expect(booleanCandidateText.ok).toBe(false);
      expect(booleanCandidateText.errors.join('\n')).toContain('invalid simplification-cut-candidate');

      const finalWithoutM5 = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
        {
          rawCodexResults: [{
            stage: 'architectural-final',
            raw: rawResult({ tokens: ['NO_FINDINGS'] }),
          }],
        },
      );
      expect(finalWithoutM5.ok, finalWithoutM5.errors.join('\n')).toBe(true);
    });

    it('fails malformed real companion body economics before transcription', () => {
      const missingPersistent = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
        {
          rawCodexResults: [{
            stage: 'architectural',
            raw: rawResult({ findings: [rawFinding({ persistent: '' })], tokens: ['SIMPLIFICATION_CLEAN'] }),
          }],
        },
      );
      expect(missingPersistent.ok).toBe(false);
      expect(missingPersistent.errors.join('\n')).toContain('persistent-machinery must be yes or no');

      const missingMarker = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
        {
          rawCodexResults: [{
            stage: 'architectural',
            raw: rawResult({ findings: [rawFinding()], tokens: ['SIMPLIFICATION_CLEAN'], marker: false }),
          }],
        },
      );
      expect(missingMarker.ok).toBe(false);
      expect(missingMarker.errors.join('\n')).toContain('missing review-economics-contract: v1');
    });

    it('exposes an executable raw-only CLI gate for the sidecar before transcription', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'finding-ledger-codex-'));
      try {
        const good = path.join(dir, 'pass-01-architectural.codex.json');
        writeFileSync(good, JSON.stringify(rawResult({ tokens: ['NO_FINDINGS', 'SIMPLIFICATION_CLEAN'] })));
        expect(runCli([
          'node',
          'scripts/finding-ledger-guard.mjs',
          '--raw-codex-only',
          '--raw-codex-stage',
          'architectural',
          '--raw-codex-file',
          good,
        ])).toBe(0);

        const bad = path.join(dir, 'pass-02-architectural.codex.json');
        writeFileSync(bad, JSON.stringify(rawResult({ findings: [rawFinding()], tokens: [] })));
        expect(runCli([
          'node',
          'scripts/finding-ledger-guard.mjs',
          '--raw-codex-only',
          '--raw-codex-stage',
          'architectural',
          '--raw-codex-file',
          bad,
        ])).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('M2 adoption cutover and stable defect economics', () => {
    it('keeps pre-adoption captures immutable and requires every post-adoption reviewer marker', () => {
      const ok = run(
        [
          cap('pass-01-architectural.capture.txt', 500, 'id: OLD\ntype: quality\nOld finding.'),
          cap('pass-02-architectural.capture.txt', 1_100, markedClean()),
        ],
        [row('OLD')],
      );
      expect(ok.ok, ok.errors.join('\n')).toBe(true);

      const missing = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, 'NO_FINDINGS'),
          cap('pass-02-architectural.capture.txt', 1_200, markedClean()),
        ],
        [],
      );
      expect(missing.ok).toBe(false);
      expect(missing.errors.join('\n')).toContain('post-adoption reviewer capture pass-01-architectural.capture.txt missing');

      const lensExcluded = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'architect lens evidence without reviewer marker'),
          cap('pass-03-architectural-final.capture.txt', 1_300, 'review-economics-contract: v1\nNO_FINDINGS'),
        ],
        [],
      );
      expect(lensExcluded.ok, lensExcluded.errors.join('\n')).toBe(true);
    });

    it('uses the latest marked proposal economics for stable-id yes/no re-emission', () => {
      const yesToNo = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedFinding('F1', { persistent: 'yes' })),
          cap('pass-02-architectural.capture.txt', 1_200, markedFinding('F1', { persistent: 'no' })),
        ],
        [row('F1')],
      );
      expect(yesToNo.ok, yesToNo.errors.join('\n')).toBe(true);

      const noToYes = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedFinding('F1', { persistent: 'no' })),
          cap('pass-02-architectural.capture.txt', 1_200, markedFinding('F1', { persistent: 'yes' })),
        ],
        [row('F1', {
          'persistent-machinery': 'yes',
          'cheapest-sufficient-alternative': 'no-build is insufficient; reuse the existing guard',
          'stakes-price': 'Goal system guarantee',
          'trade-in': 'net-add',
        })],
      );
      expect(noToYes.ok, noToYes.errors.join('\n')).toBe(true);
    });

    it('blocks missing/mismatched machinery facts and permits only explicit malformed-proposal decline', () => {
      const missing = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('F1', { persistent: '' }))],
        [row('F1')],
      );
      expect(missing.ok).toBe(false);
      expect(missing.errors.join('\n')).toContain('persistent-machinery must be yes or no');

      const mismatch = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('F1', { persistent: 'no' }))],
        [row('F1', { 'persistent-machinery': 'yes' })],
      );
      expect(mismatch.ok).toBe(false);
      expect(mismatch.errors.join('\n')).toContain('ledger persistent-machinery does not match');

      const malformed = markedFinding('F1', { persistent: 'yes', price: false });
      const rejected = run(
        [cap('pass-01-architectural.capture.txt', 1_100, malformed)],
        [row('F1', { 'persistent-machinery': 'yes' })],
      );
      expect(rejected.ok).toBe(false);
      expect(rejected.errors.join('\n')).toContain('malformed persistent-machinery proposal');

      const declined = run(
        [cap('pass-01-architectural.capture.txt', 1_100, malformed)],
        [row('F1', {
          'persistent-machinery': 'yes',
          'proposal-outcome': 'declined',
          'proposal-reason': 'malformed-proposal',
        })],
      );
      expect(declined.ok, declined.errors.join('\n')).toBe(true);
    });
  });

  describe('M3 nomination, author activation, and architect contest', () => {
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

    it('uses raw evidence only for zero-signal and preserves the global protected-signal floor', () => {
      const zero = run(
        [cap('pass-01-architectural.capture.txt', 1_100, zeroSignal)],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(zero.ok).toBe(false);
      expect(zero.errors.join('\n')).toContain('requires architect-pending');

      const pending = run(
        [cap('pass-01-architectural.capture.txt', 1_100, zeroSignal)],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation, architectPending: true })],
      );
      expect(pending.ok, pending.errors.join('\n')).toBe(true);

      const globalSignal = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('Q1', {
          type: 'quality',
          evidence: 'The proposed edit is out of scope under allowed_roots.',
        }))],
        [row('Q1')],
      );
      expect(globalSignal.ok).toBe(false);
      expect(globalSignal.errors.join('\n')).toContain('protected signal type: scope-violation present in capture but not addressed in the ledger');
    });

    it('requires architectPending at pre-lens when contest evidence is unknown or stale despite valid author activation', () => {
      const unknown = run(
        [cap('pass-01-architectural.capture.txt', 1_100, nonZero)],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(unknown.ok).toBe(false);
      expect(unknown.errors.join('\n')).toContain('requires architect-pending');

      const unknownPending = run(
        [cap('pass-01-architectural.capture.txt', 1_100, nonZero)],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation, architectPending: true })],
      );
      expect(unknownPending.ok, unknownPending.errors.join('\n')).toBe(true);

      const stale = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { revision: 'r2' })),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(stale.ok).toBe(false);
      expect(stale.errors.join('\n')).toContain('requires architect-pending');

      const stalePending = run(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { revision: 'r2' })),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation, architectPending: true })],
      );
      expect(stalePending.ok, stalePending.errors.join('\n')).toBe(true);
    });

    it('accepts valid author activation at final acceptance with current pre-terminal no-contest evidence', () => {
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1')),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('keeps an open pre-terminal contest until explicit withdrawal/adjudication and rejects ambiguous lens records', () => {
      const stillOpen = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { contest: 'contested' })),
          cap('pass-03-architectural-lens.capture.txt', 1_300, currentLens('S1', { contest: 'none' })),
          cap('pass-04-architectural.capture.txt', 1_400, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(stillOpen.ok).toBe(false);
      expect(stillOpen.errors.join('\n')).toContain('under current contest');

      const withdrawn = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { contest: 'contested' })),
          cap('pass-03-architectural-lens.capture.txt', 1_300, currentLens('S1', { contest: 'contest-withdrawn' })),
          cap('pass-04-architectural.capture.txt', 1_400, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(withdrawn.ok, withdrawn.errors.join('\n')).toBe(true);

      const duplicate = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, `${currentLens('S1')}\n${currentLens('S1', { contest: 'contested' })}`),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(duplicate.ok).toBe(false);
      expect(duplicate.errors.join('\n')).toContain('duplicate m3-protected records');

      const malformed = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1')),
          cap('pass-03-architectural-lens.capture.txt', 1_300, 'm3-protected: id=S1 | revision=r3 | contest=unknown | outcome=none | evidence= | why-now='),
          cap('pass-04-architectural.capture.txt', 1_400, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(malformed.ok).toBe(false);
      expect(malformed.errors.join('\n')).toContain('malformed m3-protected record for S1');
    });

    it('supports current pre-terminal architect activation/non-activation and rejects stale architectPending at final acceptance', () => {
      const activate = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, zeroSignal),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', {
            outcome: 'activate',
            evidence: 'The changed path is out of scope under allowed_roots.',
            whyNow: 'This task owns that path change.',
          })),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation' })],
      );
      expect(activate.ok, activate.errors.join('\n')).toBe(true);

      const nonActivate = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, zeroSignal),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { outcome: 'non-activate' })),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', disposition: 'rejected', rejectReason: 'no real protected defect' })],
      );
      expect(nonActivate.ok, nonActivate.errors.join('\n')).toBe(true);

      const stalePending = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, nonZero),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1')),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation, architectPending: true })],
      );
      expect(stalePending.ok).toBe(false);
      expect(stalePending.errors.join('\n')).toContain('must clear architect-pending');
    });
  });

  describe('M5 terminal GPT simplification verdict and anchor', () => {
    it('enforces clean/candidate token shapes, multiple candidates, and raw/ledger agreement at pre-lens', () => {
      const clean = run([cap('pass-01-architectural.capture.txt', 1_100, markedClean())], []);
      expect(clean.ok, clean.errors.join('\n')).toBe(true);

      const missingClean = run(
        [cap('pass-01-architectural.capture.txt', 1_100, 'review-economics-contract: v1\nNO_FINDINGS')],
        [],
      );
      expect(missingClean.ok).toBe(false);
      expect(missingClean.errors.join('\n')).toContain('SIMPLIFICATION_CLEAN');

      const candidate = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1', { candidate: 'yes', clean: false }))],
        [row('CUT1', { 'simplification-cut-candidate': true })],
      );
      expect(candidate.ok, candidate.errors.join('\n')).toBe(true);

      for (const value of ['maybe', '']) {
        const invalid = run(
          [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1', { candidate: value, clean: false }))],
          [row('CUT1')],
        );
        expect(invalid.ok).toBe(false);
        expect(invalid.errors.join('\n')).toContain('invalid simplification-cut-candidate');
      }

      const first = markedFinding('CUT1', { candidate: 'yes', clean: false });
      const second = markedFinding('CUT2', { candidate: 'yes', clean: false }).replace('review-economics-contract: v1\n', '');
      const multiple = run(
        [cap('pass-01-architectural.capture.txt', 1_100, `${first}\n${second}`)],
        [row('CUT1', { 'simplification-cut-candidate': true }), row('CUT2', { 'simplification-cut-candidate': true })],
      );
      expect(multiple.ok, multiple.errors.join('\n')).toBe(true);

      const mismatch = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1', { candidate: 'yes', clean: false }))],
        [row('CUT1')],
      );
      expect(mismatch.ok).toBe(false);
      expect(mismatch.errors.join('\n')).toContain('raw/ledger mismatch');

      const proseOnly = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('F1', { recommendation: 'Simplify by deleting duplication.' }))],
        [row('F1')],
      );
      expect(proseOnly.ok, proseOnly.errors.join('\n')).toBe(true);
    });

    it('selects terminal architectural after Claude and rejects old pre-lens-only ordering', () => {
      const terminal = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'claude lens'),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [],
      );
      expect(terminal.ok, terminal.errors.join('\n')).toBe(true);

      const oldOrder = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'claude lens'),
          cap('pass-03-architectural-final.capture.txt', 1_300, markedClean()),
        ],
        [],
      );
      expect(oldOrder.ok).toBe(false);
      expect(oldOrder.errors.join('\n')).toContain('cannot resolve a terminal GPT M5 anchor');
    });

    it('supports the no-Claude T1/T2-shaped final anchor and applies final M5 tokens to terminal GPT', () => {
      const noClaude = finalRun(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
      );
      expect(noClaude.ok, noClaude.errors.join('\n')).toBe(true);

      const terminalCandidate = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'claude lens'),
          cap('pass-03-architectural.capture.txt', 1_300, markedFinding('CUT1', { candidate: 'yes', clean: false })),
        ],
        [row('CUT1', { 'simplification-cut-candidate': true })],
      );
      expect(terminalCandidate.ok, terminalCandidate.errors.join('\n')).toBe(true);

      const missingClean = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'claude lens'),
          cap('pass-03-architectural.capture.txt', 1_300, 'review-economics-contract: v1\nNO_FINDINGS'),
        ],
        [],
      );
      expect(missingClean.ok).toBe(false);
      expect(missingClean.errors.join('\n')).toContain('SIMPLIFICATION_CLEAN');
    });

    it('rejects a terminal GPT anchor that is pre-adoption', () => {
      const preAdoption = finalRun(
        [cap('pass-01-architectural.capture.txt', 500, markedClean())],
        [],
      );
      expect(preAdoption.ok).toBe(false);
      expect(preAdoption.errors.join('\n')).toContain('pre-adoption terminal GPT M5 anchor');
    });
  });

  describe('terminal GPT protected nomination state', () => {
    it('uses author activation or ordinary M1 disposition without a post-terminal architect', () => {
      const nomination = markedFinding('PF1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const authorPath = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural.capture.txt', 1_300, nomination),
        ],
        [row('PF1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(authorPath.ok, authorPath.errors.join('\n')).toBe(true);

      const zeroNomination = markedFinding('PF2', {
        type: 'scope-violation',
        evidence: 'The proposed file relationship is unclear.',
        recommendation: 'Reject the unsupported nomination.',
      });
      const ordinaryM1 = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural.capture.txt', 1_300, zeroNomination),
        ],
        [row('PF2', { type: 'scope-violation', disposition: 'rejected', rejectReason: 'no real protected signal' })],
      );
      expect(ordinaryM1.ok, ordinaryM1.errors.join('\n')).toBe(true);
    });

    it('does not treat a historical architectural-final nomination as terminal GPT', () => {
      const historicalNomination = markedFinding('PF3', {
        type: 'scope-violation',
        evidence: 'The proposed file relationship is unclear.',
        recommendation: 'Do not bypass the architect requirement from historical final bytes.',
      });
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural-final.capture.txt', 1_250, historicalNomination),
          cap('pass-04-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('PF3', { type: 'scope-violation', disposition: 'rejected', rejectReason: 'historical-only nomination' })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toMatch(/unknown\/stale architect contest state|requires current architect adjudication/);
    });

    it('does not permit stale architectPending to survive on a terminal-only nomination', () => {
      const nomination = markedFinding('PF1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
      });
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural.capture.txt', 1_300, nomination),
        ],
        [row('PF1', { type: 'scope-violation', protectedActivation: authorActivation, architectPending: true })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('must not remain architect-pending');
    });

    it('preserves a genuine pre-terminal architect-required condition', () => {
      const nomination = markedFinding('PF1', {
        type: 'scope-violation',
        evidence: 'The proposed file relationship is unclear.',
      });
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, nomination),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'lens without adjudication'),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('PF1', { type: 'scope-violation', architectRequired: true })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toMatch(/unknown\/stale architect contest state|requires current architect adjudication/);
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
