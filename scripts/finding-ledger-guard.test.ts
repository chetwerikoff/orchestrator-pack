import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkFindingLedgerGuard, runCli } from './finding-ledger-guard.mjs';
import { validateTerminalOneShotBodyBinding } from './lib/create-issue-final-acceptance-contract.ts';
import { readEvidenceWaiverProducerEvidence } from './lib/create-issue-stage-record-receipt.ts';
import {
  buildReviewLaneRouting,
  classifyReviewLaneDeclaration,
  normalizeReviewLaneDeclaration,
  settleReviewLane,
  type ReviewLaneAuthorDeclaration,
} from './lib/review-lane-routing.ts';

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
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
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
          type: 'scope-violation',
          evidence: 'The proposed edit is out of scope under allowed_roots.',
        }))],
        [row('Q1')],
      );
      expect(globalSignal.ok).toBe(false);
      expect(globalSignal.errors.join('\n')).toContain('protected signal type: scope-violation present in capture but not addressed in the ledger');
    });

    it('does not treat denylist/out-of-scope prose in a typed spec finding as a protected scope-violation signal', () => {
      const specProse = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('Q1', {
          type: 'spec',
          evidence: 'Files out of scope. The denylist already names vendor/**. No type: scope-violation finding exists.',
          recommendation: 'Keep the denylist; do not invent a scope-violation row.',
        }))],
        [row('Q1', { type: 'spec' })],
      );
      expect(specProse.ok, specProse.errors.join('\n')).toBe(true);
      expect(specProse.errors.join('\n')).not.toContain('protected signal type: scope-violation');

      const typedStillProtected = run(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('S1', {
          type: 'scope-violation',
          evidence: 'The proposed edit is out of scope under allowed_roots.',
        }))],
        [row('S1')],
      );
      expect(typedStillProtected.ok).toBe(false);
      expect(typedStillProtected.errors.join('\n')).toContain('protected signal type: scope-violation present in capture but not addressed in the ledger');
    });

    it('recognizes hyphenated out-of-scope as protected evidence', () => {
      const result = finalRun(
        [cap('pass-01-architectural.capture.txt', 1_100, markedFinding('S1', {
          type: 'scope-violation',
          evidence: 'The changed path is out-of-scope.',
          recommendation: 'Keep the implementation within the declared scope.',
        }))],
        [row('S1', {
          type: 'scope-violation',
          protectedActivation: {
            authority: 'author',
            signal: 'The changed path is out-of-scope.',
            whyNow: 'The current task owns that path change.',
          },
        })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
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

    it('accepts valid author activation at final acceptance only with current unambiguous no-contest evidence', () => {
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

    it('keeps an open contest until explicit withdrawal/adjudication and rejects ambiguous lens records', () => {
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

    it('supports current architect activation/non-activation and rejects stale architectPending at final acceptance', () => {
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

  describe('M5 exact terminal simplification verdict and anchor', () => {
    it('enforces clean/candidate token shapes, multiple candidates, and raw/ledger agreement', () => {
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

    it('requires post-adoption pre-lens re-entry and reuses the anchor across same-episode relenses', () => {
      const preAdoption = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 500, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 700, 'first lens'),
          cap('pass-03-architectural.capture.txt', 900, markedClean()),
        ],
        [],
      );
      expect(preAdoption.ok).toBe(false);
      expect(preAdoption.errors.join('\n')).toContain('pre-adoption M5 anchor cannot satisfy final acceptance');

      const reentered = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 500, 'NO_FINDINGS'),
          cap('pass-02-architectural-lens.capture.txt', 700, 'first lens'),
          cap('pass-03-architectural.capture.txt', 1_200, markedClean()),
          cap('pass-04-architectural.capture.txt', 1_300, markedClean()),
          cap('pass-05-architectural-lens.capture.txt', 1_400, 'new segment lens'),
          cap('pass-06-architectural.capture.txt', 1_500, markedClean()),
        ],
        [],
      );
      expect(reentered.ok, reentered.errors.join('\n')).toBe(true);

      const sameEpisode = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'first lens'),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
          cap('pass-04-architectural-lens.capture.txt', 1_400, 'newer same-episode lens'),
          cap('pass-05-architectural.capture.txt', 1_500, markedClean()),
        ],
        [],
      );
      expect(sameEpisode.ok, sameEpisode.errors.join('\n')).toBe(true);
    });

    it('keeps historical M5 anchor separate from later M2 candidate state', () => {
      const postLensCandidate = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'first lens'),
          cap('pass-03-architectural.capture.txt', 1_300, markedFinding('POST1', { candidate: 'yes', clean: false })),
          cap('pass-04-architectural-lens.capture.txt', 1_400, 'newer lens'),
          cap('pass-05-architectural.capture.txt', 1_500, markedClean()),
        ],
        [row('POST1', { 'simplification-cut-candidate': true })],
      );
      expect(postLensCandidate.ok, postLensCandidate.errors.join('\n')).toBe(true);

      const clearedLater = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedFinding('CUT1', { candidate: 'yes', clean: false })),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'first lens'),
          cap('pass-03-architectural.capture.txt', 1_300, markedFinding('CUT1')),
          cap('pass-04-architectural-lens.capture.txt', 1_400, 'newer lens'),
          cap('pass-05-architectural.capture.txt', 1_500, markedClean()),
        ],
        [row('CUT1')],
      );
      expect(clearedLater.ok, clearedLater.errors.join('\n')).toBe(true);
    });
  });

  describe('post-final protected nomination state transitions', () => {
    it('supports author-activation audit and architect adjudication without a synthetic Issue edit', () => {
      const nomination = markedFinding('PF1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const authorPath = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural.capture.txt', 1_300, nomination),
          cap('pass-04-architectural-lens.capture.txt', 1_400, currentLens('PF1', { contest: 'none' })),
          cap('pass-05-architectural.capture.txt', 1_500, markedClean()),
        ],
        [row('PF1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(authorPath.ok, authorPath.errors.join('\n')).toBe(true);

      const zeroNomination = markedFinding('PF1', {
        type: 'scope-violation',
        evidence: 'The proposed file relationship is unclear.',
        recommendation: 'Add a denylist rule.',
      });
      const architectPath = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural.capture.txt', 1_300, zeroNomination),
          cap('pass-04-architectural-lens.capture.txt', 1_400, currentLens('PF1', {
            outcome: 'activate',
            evidence: 'The proposed path is out of scope under allowed_roots.',
            whyNow: 'The current task owns the proposed path change.',
          })),
          cap('pass-05-architectural.capture.txt', 1_500, markedClean()),
        ],
        [row('PF1', { type: 'scope-violation' })],
      );
      expect(architectPath.ok, architectPath.errors.join('\n')).toBe(true);
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


  describe('#1062 terminal GPT guard realignment', () => {
    it('resolves final-acceptance M5 from terminal architectural without architectural-lens', () => {
      const result = finalRun(
        [cap('pass-01-architectural.capture.txt', 1_100, markedClean())],
        [],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('accepts a protected nomination first present in terminal GPT when author activation is valid', () => {
      const nomination = markedFinding('S1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens without S1 record'),
          cap('pass-03-architectural.capture.txt', 1_300, nomination),
        ],
        [row('S1', { type: 'scope-violation', protectedActivation: authorActivation })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });



    it('rejects final acceptance when a protected nomination first appears in the Claude lens without architect state', () => {
      const lensNomination = markedFinding('S1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, lensNomination),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', disposition: 'rejected', rejectReason: 'not material' })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('unknown/stale architect contest state');
    });

    it('rejects final acceptance when a pre-lens protected nomination lacks a current lens record', () => {
      const preLens = markedFinding('S1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const result = finalRun(
        [
          cap('pass-01-architectural.capture.txt', 1_100, preLens),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens without S1 record'),
          cap('pass-03-architectural.capture.txt', 1_300, markedClean()),
        ],
        [row('S1', { type: 'scope-violation', disposition: 'addressed' })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('unknown/stale architect contest state');
    });

    it('keeps architectRequired binding for terminal-only nominations without a post-terminal lens record', () => {
      const terminalNomination = markedFinding('S1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, 'initial lens'),
          cap('pass-03-architectural.capture.txt', 1_300, terminalNomination),
        ],
        [row('S1', { type: 'scope-violation', architectRequired: true })],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('requires current architect adjudication');
    });


    it('accepts authoritative GPT architectural M3 adjudication superseding Claude on the same revision', () => {
      const nomination = markedFinding('S1', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
        recommendation: 'Keep the implementation in the declared path.',
      });
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural-lens.capture.txt', 1_200, currentLens('S1', { contest: 'contested' })),
          cap('pass-03-architectural.capture.txt', 1_300, `${nomination}
${currentLens('S1', { contest: 'none', outcome: 'non-activate' })}`),
        ],
        [row('S1', { type: 'scope-violation', disposition: 'rejected', rejectReason: 'not material' })],
        { issueRevision: 'r3' },
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('accepts GPT adjudication for a protected nomination first emitted in terminal architectural', () => {
      const nomination = markedFinding('GT1', {
        type: 'security',
        evidence: 'The proposed unauthenticated endpoint is a security issue.',
      });
      const result = finalRun(
        [
          cap('pass-01-architectural-lens.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural.capture.txt', 1_200, `${nomination}\n${currentLens('GT1', {
            outcome: 'activate',
            evidence: 'The unauthenticated endpoint is a security issue.',
            whyNow: 'It is introduced by the current revision.',
          })}`),
        ],
        [row('GT1', { type: 'security', disposition: 'addressed' })],
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    });

    it('fails closed on stale or malformed terminal GPT M3 state', () => {
      const nomination = markedFinding('GT2', {
        type: 'scope-violation',
        evidence: 'The proposed file is out of scope under allowed_roots.',
      });
      const stale = finalRun(
        [
          cap('pass-01-architectural-lens.capture.txt', 1_100, currentLens('GT2', { outcome: 'non-activate' })),
          cap('pass-02-architectural.capture.txt', 1_200, `${nomination}\n${currentLens('GT2', {
            revision: 'r2',
            outcome: 'non-activate',
          })}`),
        ],
        [row('GT2', { type: 'scope-violation', disposition: 'rejected', rejectReason: 'not material' })],
      );
      expect(stale.errors.join('\n')).toContain('unknown/stale architect contest state');

      const malformed = finalRun(
        [
          cap('pass-01-architectural-lens.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural.capture.txt', 1_200, `${nomination}\nm3-protected: id=GT2 | revision=r3 | contest=invalid | outcome=none`),
        ],
        [row('GT2', { type: 'scope-violation' })],
      );
      expect(malformed.errors.join('\n')).toContain('malformed m3-protected record for GT2');
    });

    it('rejects duplicate-conflicting, invalid activation, and unresolved GPT contest state', () => {
      const nomination = markedFinding('GT3', {
        type: 'security',
        evidence: 'The unauthenticated endpoint is a security issue.',
      });
      const duplicate = finalRun(
        [
          cap('pass-01-architectural-lens.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural.capture.txt', 1_200, `${nomination}\n${currentLens('GT3', { outcome: 'non-activate' })}\n${currentLens('GT3', { outcome: 'activate', evidence: 'security issue', whyNow: 'now' })}`),
        ],
        [row('GT3', { type: 'security' })],
      );
      expect(duplicate.errors.join('\n')).toContain('duplicate m3-protected records for GT3');

      const conflictingCaptures = finalRun(
        [
          cap('pass-01-architectural-lens.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural.capture.txt', 1_200, `${nomination}\n${currentLens('GT3', { outcome: 'non-activate' })}`),
          cap('pass-03-architectural.capture.txt', 1_300, currentLens('GT3', {
            outcome: 'activate', evidence: 'security issue', whyNow: 'Current revision.',
          })),
        ],
        [row('GT3', { type: 'security' })],
      );
      expect(conflictingCaptures.errors.join('\n')).toContain('duplicate-conflicting terminal m3-protected state');

      const invalidActivation = finalRun(
        [
          cap('pass-01-architectural-lens.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural.capture.txt', 1_200, `${nomination}\n${currentLens('GT3', {
            outcome: 'activate',
            evidence: 'No protected evidence here.',
            whyNow: 'Current revision.',
          })}`),
        ],
        [row('GT3', { type: 'security' })],
      );
      expect(invalidActivation.errors.join('\n')).toContain('lacks current real protected evidence + why-now provenance');

      const contested = finalRun(
        [
          cap('pass-01-architectural-lens.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural.capture.txt', 1_200, `${nomination}\n${currentLens('GT3', { contest: 'contested' })}`),
        ],
        [row('GT3', { type: 'security' })],
      );
      expect(contested.errors.join('\n')).toContain('under current contest');
    });

    it('rejects final acceptance when terminal architectural is stale relative to the latest lens', () => {
      const result = finalRun(
        [
          cap('pass-01-competitive.capture.txt', 1_100, markedClean()),
          cap('pass-02-architectural.capture.txt', 1_150, markedClean()),
          cap('pass-03-architectural-lens.capture.txt', 1_200, 'first lens'),
          cap('pass-04-architectural-lens.capture.txt', 1_400, 'newer lens'),
        ],
        [],
      );
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('cannot resolve a terminal architectural M5 anchor');
    });
  });

describe('Issue #1171 terminal disposition matrix', () => {
  function terminalLedger(rowValue: Row, options: Record<string, unknown> = {}) {
    const findingId = rowValue.id;
    const capture = cap('pass-03-architectural.capture.txt', 1_300, markedFinding(findingId, {
      type: typeof rowValue.type === 'string' ? rowValue.type : 'quality',
    }));
    return checkFindingLedgerGuard(capture.text, JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{ ...rowValue, occurrences: [`${findingId}@0:1`] }],
    }), {
      reviewEconomics: true,
      phase: 'final-acceptance',
      issueRevision: 'r3',
      stageTerminalConfirmed: true,
      captureMetadata: [{ name: capture.name, timestampMs: capture.timestampMs }],
      ...options,
    } as never);
  }

  it('accepts an addressed non-protected terminal defect after one certified correction', () => {
    const findingId = 'no-local-run-store-root-not-exhaustive';
    const reviewedBody = `<!-- source-revision: r09 -->\n${markedFinding(findingId, { type: 'spec' })}`;
    const correctedBody = `<!-- source-revision: r10 -->\n${markedFinding(findingId, {
      type: 'spec',
      evidence: 'The corrected live Issue bytes close the terminal specification finding.',
    })}`;
    const certificationErrors: string[] = [];
    const certified = validateTerminalOneShotBodyBinding(
      reviewedBody,
      correctedBody,
      'r10',
      [{ stage: 'architectural', outcome: 'complete', sourceRevision: 'r09' }],
      certificationErrors,
    );
    expect(certificationErrors).toEqual([]);
    expect(certified).toBe(true);

    const result = terminalLedger(row(findingId, {
      type: 'spec',
      defectDisposition: 'addressed',
      remedyDisposition: 'accepted',
    }), { terminalCorrectionCertified: certified });
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('accepts an exact terminal capture when every defect is validly rejected-as-false', () => {
    const result = terminalLedger(row('F1', {
      defectDisposition: 'rejected-as-false',
      rejectReason: 'the report misread the existing contract',
      remedyDisposition: 'accepted',
    }));
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('blocks a terminal defect marked addressed instead of certifying corrected bytes', () => {
    const result = terminalLedger(row('F1', {
      defectDisposition: 'addressed',
      remedyDisposition: 'accepted',
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('blocked_terminal_findings');
  });

  it('allows an activated protected terminal defect marked addressed', () => {
    const capture = cap('pass-03-architectural.capture.txt', 1_300, `${markedFinding('F1', {
      type: 'scope-violation',
      evidence: 'The changed path is out of scope under allowed_roots.',
    })}
${currentLens('F1', {
      outcome: 'activate',
      evidence: 'The changed path is out of scope under allowed_roots.',
      whyNow: 'The current revision requires this protected defect to be addressed.',
    })}`);
    const result = checkFindingLedgerGuard(capture.text, JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{
        ...row('F1', {
          type: 'scope-violation',
          defectDisposition: 'addressed',
          remedyDisposition: 'accepted',
        }),
        occurrences: ['F1@0:1'],
      }],
    }), {
      reviewEconomics: true,
      phase: 'final-acceptance',
      issueRevision: 'r3',
      stageTerminalConfirmed: true,
      captureMetadata: [{ name: capture.name, timestampMs: capture.timestampMs }],
    } as never);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('requires defect-side evidence for rejected-as-false terminal disposition', () => {
    const result = terminalLedger(row('F1', {
      defectDisposition: 'rejected-as-false',
      remedyDisposition: 'accepted',
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('rejected-as-false');
  });
});

describe('receipt-backed occurrence M3 lookup uses capture finding id', () => {
  it('resolves GitHub-identity occurrences from m3-protected id= finding lines', () => {
    const findingId = 'SEC1';
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const captureIdentity = `sha256:83b098b700000000000000000000000000000000000000000000000000000000:${reviewName}`;
    const occurrenceId = `${captureIdentity}:1`;
    const githubCapture = cap(reviewName, 1_100, markedFinding(findingId, {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    }));
    const localArchitectural = cap(
      'pass-02-architectural.capture.txt',
      1_200,
      `${markedClean()}\n${currentLens(findingId, { contest: 'none', outcome: 'non-activate' })}`,
    );
    const result = checkFindingLedgerGuard(
      [githubCapture.text, localArchitectural.text],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
        findings: [{
          id: findingId,
          summary: 'security boundary',
          type: 'security',
          occurrences: [occurrenceId],
          defectDisposition: 'rejected-as-false',
          rejectReason: 'the report misread the existing contract',
          remedyDisposition: 'accepted',
          'persistent-machinery': 'no',
        }],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: githubCapture.name, timestampMs: githubCapture.timestampMs, captureIdentity },
          { name: localArchitectural.name, timestampMs: localArchitectural.timestampMs },
        ],
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not treat an AR+lens stage pair sharing a capture finding id as ambiguous', () => {
    const findingId = 'precedence-safety-boundary-order-inverted';
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const lensName = 'pass-02-architectural-lens.capture.txt';
    const identityAr = `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${reviewName}`;
    const identityLens = `sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:${lensName}`;
    const occurrenceAr = `${identityAr}:1`;
    const occurrenceLens = `${identityLens}:1`;
    const finding = markedFinding(findingId, {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    });
    const result = checkFindingLedgerGuard(
      [
        finding,
        finding,
        `${markedClean()}\n${currentLens(findingId, { contest: 'none', outcome: 'non-activate' })}`,
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
        findings: [
          {
            id: 'ROW-AR',
            summary: 'security AR',
            type: 'security',
            occurrences: [occurrenceAr],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
          {
            id: 'ROW-LENS',
            summary: 'security lens',
            type: 'security',
            occurrences: [occurrenceLens],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
        ],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity: identityAr },
          { name: lensName, timestampMs: 1_110, captureIdentity: identityLens },
          { name: 'pass-03-architectural.capture.txt', timestampMs: 1_200 },
        ],
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not unknown/stale a locked AR occurrence without m3-protected when disposition is rejected-as-false', () => {
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const captureIdentity = `sha256:83b098b700000000000000000000000000000000000000000000000000000000:${reviewName}`;
    const occurrenceQuality = `${captureIdentity}:1`;
    const occurrenceScope = `${captureIdentity}:2`;
    const githubCapture = [
      'review-economics-contract: v1',
      'id: Q1',
      'type: quality',
      'severity: P1',
      'evidence: Observable contract is violated.',
      'recommendation: Use the cheapest sufficient correction.',
      'persistent-machinery: no',
      'id: SV1',
      'type: scope-violation',
      'severity: P1',
      'evidence: The proposed file is out of scope under allowed_roots.',
      'recommendation: Keep the implementation in the declared path.',
      'persistent-machinery: no',
      'SIMPLIFICATION_CLEAN',
    ].join('\n');
    const result = checkFindingLedgerGuard(
      [githubCapture, markedClean()],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
        findings: [
          {
            id: 'Q1',
            summary: 'quality finding',
            type: 'quality',
            occurrences: [occurrenceQuality],
            defectDisposition: 'addressed',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
          {
            id: 'SV1',
            summary: 'scope violation',
            type: 'scope-violation',
            occurrences: [occurrenceScope],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
            protectedOccurrences: [{
              occurrenceId: occurrenceScope,
              architectPending: false,
              architectRequired: false,
              protectedActivation: null,
            }],
          },
        ],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity },
          { name: 'pass-02-architectural.capture.txt', timestampMs: 1_200 },
        ],
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not treat two architectural-review captures sharing a capture finding id as ambiguous', () => {
    const findingId = 'precedence-safety-boundary-order-inverted';
    const reviewOne = 'pass-01-architectural-review-01.capture.txt';
    const reviewTwo = 'pass-01-architectural-review-02.capture.txt';
    const identityOne = `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${reviewOne}`;
    const identityTwo = `sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:${reviewTwo}`;
    const occurrenceOne = `${identityOne}:1`;
    const occurrenceTwo = `${identityTwo}:1`;
    const finding = markedFinding(findingId, {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    });
    const result = checkFindingLedgerGuard(
      [
        finding,
        finding,
        `${markedClean()}\n${currentLens(findingId, { contest: 'none', outcome: 'non-activate' })}`,
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
        findings: [
          {
            id: 'ROW-A',
            summary: 'security A',
            type: 'security',
            occurrences: [occurrenceOne],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
          {
            id: 'ROW-B',
            summary: 'security B',
            type: 'security',
            occurrences: [occurrenceTwo],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
        ],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewOne, timestampMs: 1_100, captureIdentity: identityOne },
          { name: reviewTwo, timestampMs: 1_110, captureIdentity: identityTwo },
          { name: 'pass-02-architectural.capture.txt', timestampMs: 1_200 },
        ],
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not treat a T2 AR + pass-NN-architectural lens capture sharing a capture finding id as ambiguous', () => {
    const findingId = 'precedence-safety-boundary-order-inverted';
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const lensName = 'pass-02-architectural.capture.txt';
    const identityAr = `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${reviewName}`;
    const identityLens = `sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:${lensName}`;
    const occurrenceAr = `${identityAr}:1`;
    const occurrenceLens = `${identityLens}:1`;
    const finding = markedFinding(findingId, {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    });
    const result = checkFindingLedgerGuard(
      [
        finding,
        `${finding}\n${currentLens(findingId, { contest: 'none', outcome: 'non-activate' })}`,
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
        findings: [
          {
            id: 'ROW-AR',
            summary: 'security AR',
            type: 'security',
            occurrences: [occurrenceAr],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
          {
            id: 'ROW-LENS',
            summary: 'security T2 architectural lens',
            type: 'security',
            occurrences: [occurrenceLens],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
        ],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity: identityAr },
          { name: lensName, timestampMs: 1_110, captureIdentity: identityLens },
        ],
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not unknown/stale a locked T2 architectural lens occurrence without m3-protected when disposition is rejected-as-false', () => {
    const findingId = 'precedence-safety-boundary-order-inverted-architectural';
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const lensName = 'pass-02-architectural.capture.txt';
    const identityAr = `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${reviewName}`;
    const identityLens = `sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:${lensName}`;
    const occurrenceAr = `${identityAr}:1`;
    const occurrenceLens = `${identityLens}:1`;
    const finding = markedFinding(findingId, {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    });
    const result = checkFindingLedgerGuard(
      [
        finding,
        finding,
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
        findings: [
          {
            id: 'ROW-AR',
            summary: 'security AR',
            type: 'security',
            occurrences: [occurrenceAr],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
          {
            id: 'ROW-LENS',
            summary: 'security T2 architectural lens',
            type: 'security',
            occurrences: [occurrenceLens],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
            protectedOccurrences: [{
              occurrenceId: occurrenceLens,
              architectPending: false,
              architectRequired: false,
              protectedActivation: null,
            }],
          },
        ],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity: identityAr },
          { name: lensName, timestampMs: 1_110, captureIdentity: identityLens },
        ],
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('still fail-closes a locked T2 architectural lens rejected-as-false row that carries valid protectedActivation', () => {
    const findingId = 'precedence-safety-boundary-order-inverted-architectural';
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const lensName = 'pass-02-architectural.capture.txt';
    const identityAr = `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${reviewName}`;
    const identityLens = `sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:${lensName}`;
    const occurrenceAr = `${identityAr}:1`;
    const occurrenceLens = `${identityLens}:1`;
    const finding = markedFinding(findingId, {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    });
    const result = checkFindingLedgerGuard(
      [
        finding,
        finding,
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
        findings: [
          {
            id: 'ROW-AR',
            summary: 'security AR',
            type: 'security',
            occurrences: [occurrenceAr],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
          {
            id: 'ROW-LENS',
            summary: 'security T2 architectural lens',
            type: 'security',
            occurrences: [occurrenceLens],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
            protectedOccurrences: [{
              occurrenceId: occurrenceLens,
              architectPending: false,
              architectRequired: false,
              protectedActivation: {
                authority: 'author',
                signal: 'A security issue is present in the proposed boundary.',
                whyNow: 'The current revision introduces that boundary.',
              },
            }],
          },
        ],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity: identityAr },
          { name: lensName, timestampMs: 1_110, captureIdentity: identityLens },
        ],
      } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/must be addressed|blocked_terminal_findings|unknown\/stale architect contest state/);
  });

  it('still fails closed when the same capture finding id is reused inside one capture', () => {
    const findingId = 'S1';
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const captureIdentity = `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${reviewName}`;
    const occurrenceOne = `${captureIdentity}:1`;
    const occurrenceTwo = `${captureIdentity}:2`;
    const finding = markedFinding(findingId, {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    });
    const result = checkFindingLedgerGuard(
      [
        `${finding}\n${finding}`,
        `${markedClean()}\n${currentLens(findingId, { contest: 'none', outcome: 'non-activate' })}`,
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 2, distinctFindingCount: 2, processedDistinctCount: 2 },
        findings: [
          {
            id: 'ROW-A',
            summary: 'security A',
            type: 'security',
            occurrences: [occurrenceOne],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
          {
            id: 'ROW-B',
            summary: 'security B',
            type: 'security',
            occurrences: [occurrenceTwo],
            defectDisposition: 'rejected-as-false',
            rejectReason: 'the report misread the existing contract',
            remedyDisposition: 'accepted',
            'persistent-machinery': 'no',
          },
        ],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity },
          { name: 'pass-02-architectural.capture.txt', timestampMs: 1_200 },
        ],
      } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('ambiguous capture finding id');
  });

  it('still unknown/stale a T1-only locked architectural occurrence without m3-protected when disposition is rejected-as-false', () => {
    const architecturalName = 'pass-01-architectural.capture.txt';
    const captureIdentity = `sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd:${architecturalName}`;
    const occurrenceId = `${captureIdentity}:1`;
    const result = checkFindingLedgerGuard(
      [
        markedFinding('SEC1', {
          type: 'security',
          evidence: 'A security issue is present in the proposed boundary.',
        }),
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
        findings: [{
          id: 'SEC1',
          summary: 'security T1 architectural',
          type: 'security',
          occurrences: [occurrenceId],
          defectDisposition: 'rejected-as-false',
          rejectReason: 'the report misread the existing contract',
          remedyDisposition: 'accepted',
          'persistent-machinery': 'no',
          protectedOccurrences: [{
            occurrenceId,
            architectPending: false,
            architectRequired: false,
            protectedActivation: null,
          }],
        }],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: architecturalName, timestampMs: 1_100, captureIdentity },
        ],
      } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('unknown/stale architect contest state');
  });

  it('still unknown/stale a T3 AR + architectural-lens + architectural occurrence without m3-protected when disposition is rejected-as-false', () => {
    const reviewName = 'pass-01-architectural-review-01.capture.txt';
    const claudeLensName = 'pass-02-architectural-lens.capture.txt';
    const architecturalName = 'pass-03-architectural.capture.txt';
    const identityAr = `sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:${reviewName}`;
    const identityClaude = `sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:${claudeLensName}`;
    const identityTerminal = `sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:${architecturalName}`;
    const occurrenceId = `${identityTerminal}:1`;
    const finding = markedFinding('SEC1', {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    });
    const result = checkFindingLedgerGuard(
      [
        markedClean(),
        markedClean(),
        finding,
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
        findings: [{
          id: 'SEC1',
          summary: 'security T3 terminal architectural',
          type: 'security',
          occurrences: [occurrenceId],
          defectDisposition: 'rejected-as-false',
          rejectReason: 'the report misread the existing contract',
          remedyDisposition: 'accepted',
          'persistent-machinery': 'no',
          protectedOccurrences: [{
            occurrenceId,
            architectPending: false,
            architectRequired: false,
            protectedActivation: null,
          }],
        }],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: reviewName, timestampMs: 1_100, captureIdentity: identityAr },
          { name: claudeLensName, timestampMs: 1_110, captureIdentity: identityClaude },
          { name: architecturalName, timestampMs: 1_120, captureIdentity: identityTerminal },
        ],
      } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('unknown/stale architect contest state');
  });

  it('still unknown/stale an unadjudicated architectural-lens protected finding without m3-protected', () => {
    const lensName = 'pass-02-architectural-lens.capture.txt';
    const captureIdentity = `sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:${lensName}`;
    const occurrenceId = `${captureIdentity}:1`;
    const result = checkFindingLedgerGuard(
      [
        markedFinding('SEC1', {
          type: 'security',
          evidence: 'A security issue is present in the proposed boundary.',
        }),
        markedClean(),
      ],
      JSON.stringify({
        version: 2,
        counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
        findings: [{
          id: 'SEC1',
          summary: 'security lens',
          type: 'security',
          occurrences: [occurrenceId],
          defectDisposition: 'rejected-as-false',
          rejectReason: 'the report misread the existing contract',
          remedyDisposition: 'accepted',
          'persistent-machinery': 'no',
          protectedOccurrences: [{
            occurrenceId,
            architectPending: false,
            architectRequired: false,
            protectedActivation: null,
          }],
        }],
      }),
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r3',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: lensName, timestampMs: 1_100, captureIdentity },
          { name: 'pass-03-architectural.capture.txt', timestampMs: 1_200 },
        ],
      } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('unknown/stale architect contest state');
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


describe('published author-state M3 bridge', () => {
  it('uses hash-pinned published author-state without mutating capture text', () => {
    const capture = cap(
      'pass-01-architectural.capture.txt',
      1_300,
      markedFinding('S1', {
        type: 'scope-violation',
        evidence: 'The proposed edit is out of scope under allowed_roots.',
      }),
    );
    const captureIdentity = `sha256:${'a'.repeat(64)}:${capture.name}`;
    const occurrenceId = `${captureIdentity}:1`;
    const ledger = JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{
        ...row('S1', {
          type: 'scope-violation',
          defectDisposition: 'addressed',
          remedyDisposition: 'accepted',
          occurrences: [occurrenceId],
          protectedOccurrences: [{
            occurrenceId,
            architectPending: false,
            architectRequired: false,
            protectedActivation: null,
          }],
        }),
      }],
    });
    const options = {
      reviewEconomics: true,
      phase: 'final-acceptance',
      issueRevision: 'r3',
      stageTerminalConfirmed: true,
      captureMetadata: [{ name: capture.name, timestampMs: capture.timestampMs, captureIdentity }],
    };
    const publishedAuthorState = currentLens(occurrenceId, { outcome: 'non-activate' });
    const withoutPublishedState = checkFindingLedgerGuard(capture.text, ledger, options);
    expect(withoutPublishedState.ok).toBe(false);
    expect(withoutPublishedState.errors.join('\n')).toContain('unknown/stale architect contest state');

    const withPublishedState = checkFindingLedgerGuard(capture.text, ledger, {
      ...options,
      publishedAuthorState: {
        text: publishedAuthorState,
        sha256: createHash('sha256').update(publishedAuthorState).digest('hex'),
        byteLength: Buffer.byteLength(publishedAuthorState),
      },
    });
    expect(withPublishedState.ok, withPublishedState.errors.join('\n')).toBe(true);
    expect(capture.text).not.toContain(publishedAuthorState);
  });
  it('uses a current r07 author-state to supersede an immutable contested lens and anchor M5', () => {
    const captureText = markedFinding('S1', {
      type: 'scope-violation',
      evidence: 'The proposed edit is out of scope under allowed_roots.',
    });
    const capture = cap('pass-01-architectural.capture.txt', 1_300, captureText);
    const captureIdentity = `sha256:${'b'.repeat(64)}:${capture.name}`;
    const occurrenceId = `${captureIdentity}:1`;
    capture.text = `${capture.text}\n${currentLens(occurrenceId, { revision: 'r06', contest: 'none' })}`;
    const lens = cap(
      'pass-02-architectural-lens.capture.txt',
      1_400,
      currentLens(occurrenceId, { revision: 'r06', contest: 'contested' }),
    );
    const ledger = JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{
        ...row('S1', {
          type: 'scope-violation',
          defectDisposition: 'rejected-as-false',
          rejectReason: 'the published author adjudication rejects the report',
          remedyDisposition: 'accepted',
          occurrences: [occurrenceId],
          protectedOccurrences: [{
            occurrenceId,
            architectPending: false,
            architectRequired: false,
            protectedActivation: null,
          }],
        }),
      }],
    });
    const publishedAuthorState = currentLens(occurrenceId, {
      revision: 'r07',
      outcome: 'non-activate',
    });
    const result = checkFindingLedgerGuard(
      [capture.text, lens.text],
      ledger,
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r07',
        stageTerminalConfirmed: true,
        captureMetadata: [
          { name: capture.name, timestampMs: capture.timestampMs, captureIdentity },
          { name: lens.name, timestampMs: lens.timestampMs },
        ],
        publishedAuthorState: {
          text: publishedAuthorState,
          sha256: createHash('sha256').update(publishedAuthorState).digest('hex'),
          byteLength: Buffer.byteLength(publishedAuthorState),
        },
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(capture.text).not.toContain(publishedAuthorState);
    expect(lens.text).not.toContain(publishedAuthorState);
  });

  it('uses the current occurrence author-state when a stale stable-id lens contest is also present', () => {
    const lensName = 'pass-03-architectural-lens.capture.txt';
    const captureIdentity = `sha256:523b8be7a22db5c5fe85b483d86f3dc1b079929c4a54b4cebd796d87925abc5a:${lensName}`;
    const occurrenceId = `${captureIdentity}:1`;
    const capture = `${markedFinding('SEC1', {
      type: 'security',
      evidence: 'A security issue is present in the proposed boundary.',
    })}\n${currentLens('SEC1', { revision: 'r06', contest: 'contested' })}`;
    const ledger = JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 1 },
      findings: [{
        ...row('SEC1', {
          type: 'security',
          defectDisposition: 'rejected-as-false',
          rejectReason: 'the published author adjudication rejects the report',
          remedyDisposition: 'accepted',
          occurrences: [occurrenceId],
          protectedOccurrences: [{
            occurrenceId,
            architectPending: false,
            architectRequired: false,
            protectedActivation: null,
          }],
        }),
      }],
    });
    const publishedAuthorState = currentLens(occurrenceId, {
      revision: 'r07',
      outcome: 'non-activate',
    });
    const result = checkFindingLedgerGuard(
      [capture],
      ledger,
      {
        reviewEconomics: true,
        phase: 'final-acceptance',
        issueRevision: 'r07',
        stageTerminalConfirmed: true,
        captureMetadata: [{ name: lensName, timestampMs: 1_400, captureIdentity }],
        publishedAuthorState: {
          text: publishedAuthorState,
          sha256: createHash('sha256').update(publishedAuthorState).digest('hex'),
          byteLength: Buffer.byteLength(publishedAuthorState),
        },
      } as never,
    );
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('clears pending state from the published r07 M3 bundle across all four attempts', () => {
    const protectedOccurrences = [
      {
        id: 'sha256:215afa06e428c2d6d569d4f9850c36613107c1f2909430091490f8263a5825b2:pass-01-competitive-01.capture.txt:3',
        findingId: 'C1', type: 'scope-violation', ordinal: 3, timestampMs: 1_100,
        name: 'pass-01-competitive-01.capture.txt',
        evidence: 'The proposed path is out of scope under allowed_roots.',
      },
      {
        id: 'sha256:c4c7e99270edf124453d2d8199a7897e6e7c14e7f4b147ebe61e88456b7480a1:pass-01-competitive-02.capture.txt:3',
        findingId: 'C2', type: 'scope-violation', ordinal: 3, timestampMs: 1_200,
        name: 'pass-01-competitive-02.capture.txt',
        evidence: 'The proposed path is out of scope under allowed_roots.',
      },
      {
        id: 'sha256:09db790ddda8c9b8abd13693a8f883d14415bb35872c29bed7926de458fd96db:pass-02-architectural-review-01.capture.txt:1',
        findingId: 'A1', type: 'scope-violation', ordinal: 1, timestampMs: 1_300,
        name: 'pass-02-architectural-review-01.capture.txt',
        evidence: 'The proposed path is out of scope under allowed_roots.',
      },
      {
        id: 'sha256:523b8be7a22db5c5fe85b483d86f3dc1b079929c4a54b4cebd796d87925abc5a:pass-03-architectural-lens.capture.txt:8',
        findingId: 'L8', type: 'scope-violation', ordinal: 8, timestampMs: 1_400,
        name: 'pass-03-architectural-lens.capture.txt',
        evidence: 'The proposed path is out of scope under allowed_roots.',
      },
    ] as const;
    const captures = protectedOccurrences.map((item) => {
      const filler = Array.from({ length: item.ordinal - 1 }, (_, index) => markedFinding(`FILLER-${item.findingId}-${index}`, { type: 'quality' })).join('\n');
      return cap(item.name, item.timestampMs, `${filler}${filler ? '\n' : ''}${markedFinding(item.findingId, { type: item.type, evidence: item.evidence })}`);
    }).concat([cap('pass-04-architectural.capture.txt', 1_500, markedClean())]);
    const captureIdentity = (item: (typeof protectedOccurrences)[number]) => item.id.replace(/:\d+$/, '');
    const fillerRows = protectedOccurrences.flatMap((item) => Array.from({ length: item.ordinal - 1 }, (_, index) => row(`FILLER-${item.findingId}-${index}`, {
      type: 'quality',
      defectDisposition: 'addressed',
      remedyDisposition: 'accepted',
      occurrences: [`${captureIdentity(item)}:${index + 1}`],
    })));
    const protectedRows = protectedOccurrences.map((item) => row(item.findingId, {
      type: item.type,
      defectDisposition: 'addressed',
      remedyDisposition: 'accepted',
      occurrences: [item.id],
      protectedOccurrences: [{ occurrenceId: item.id, architectPending: true, architectRequired: false, protectedActivation: null }],
    }));
    const rows = [...fillerRows, ...protectedRows];
    const ledger = JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 15, distinctFindingCount: 15, processedDistinctCount: 15 },
      findings: rows,
    });
    const captureMetadata = captures.map((capture) => ({
      name: capture.name,
      timestampMs: capture.timestampMs,
      ...(protectedOccurrences.find((item) => item.name === capture.name)
        ? { captureIdentity: protectedOccurrences.find((item) => item.name === capture.name)!.id.replace(/:\d+$/, '') }
        : {}),
    }));
    const publishedAuthorState = protectedOccurrences
      .map((item) => currentLens(item.id, { revision: 'r07', outcome: 'non-activate' }))
      .join('\n');
    const options = {
      reviewEconomics: true,
      phase: 'final-acceptance',
      issueRevision: 'r07',
      stageTerminalConfirmed: true,
      captureMetadata,
    };
    const withoutPublishedState = checkFindingLedgerGuard(captures.map((capture) => capture.text), ledger, options as never);
    expect(withoutPublishedState.ok).toBe(false);
    expect(withoutPublishedState.errors.join('\n')).toContain('architect-pending');

    const result = checkFindingLedgerGuard(captures.map((capture) => capture.text), ledger, {
      ...options,
      publishedAuthorState: {
        text: publishedAuthorState,
        sha256: createHash('sha256').update(publishedAuthorState).digest('hex'),
        byteLength: Buffer.byteLength(publishedAuthorState),
      },
    } as never);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

});

describe('receipt-backed finding ledger operator-stage waiver regression #1778', () => {
  function waivedArchitecturalReviewFixture(captureText = markedClean()) {
    const sourceRevision = 'r01';
    const taskIdentity = 'issue:1778';
    const reviewEpisodeId = taskIdentity + '@' + sourceRevision;
    const stageAttemptId = 'attempt-1';
    const stageReceiptId = reviewEpisodeId + ':stage-receipt:0001';
    const captureName = 'pass-01-architectural-review-01.capture.txt';
    const captureSha256 = createHash('sha256').update(captureText).digest('hex');
    const rawFindingCount = captureText === markedClean() ? 0 : 1;
    const captureIdentity = 'sha256:' + captureSha256 + ':' + captureName;
    const capture = {
      captureIdentity,
      name: captureName,
      byteLength: Buffer.byteLength(captureText),
      sha256: captureSha256,
      rawFindingCount,
    };

    const laneDeclaration: ReviewLaneAuthorDeclaration = {
      schema: 'review-lane-change-set/v1',
      owner: 'issue-author',
      entries: [{
        kind: 'exact',
        path: 'scripts/chatgpt-browser-turn/driver.ts',
        behaviors: ['pure-review-lane-selection'],
      }],
    };
    const laneInput = normalizeReviewLaneDeclaration(laneDeclaration);
    const classification = classifyReviewLaneDeclaration(laneDeclaration);
    if (laneInput.status !== 'usable') throw new Error('waiver fixture input must be usable');
    const routing = buildReviewLaneRouting(laneInput, classification, sourceRevision, stageAttemptId);
    const sourceVerdict = rawFindingCount === 0 ? 'accept' as const : 'material-findings' as const;
    const settlement = settleReviewLane(routing, {
      '01': sourceVerdict,
      '02': sourceVerdict,
      '03': sourceVerdict,
    });
    const reviewLane = {
      routing,
      finalRequiredSlots: settlement.finalRequiredSlots,
      sourceVerdicts: { '01': sourceVerdict },
      sourceVerdictEvidence: {
        '01': {
          producerEvidenceIdentity: 'producer-01',
          captureIdentity,
          terminalClassification: 'complete',
          captureVerified: true,
          digestMatches: true,
          verdictText: rawFindingCount === 0 ? 'NO_FINDINGS' : 'FINDINGS',
          rawFindingCount,
        },
      },
      conflictDecision: settlement.conflictDecision,
      settlement,
    };
    const partialMissingSources = [
      {
        reviewerSlot: '02',
        invocationId: 'invocation-02',
        evidenceIdentity: 'terminal-02',
        reason: 'possible-or-actual send with resend forbidden',
      },
      {
        reviewerSlot: '03',
        invocationId: 'invocation-03',
        evidenceIdentity: 'terminal-03',
        reason: 'possible-or-actual send with resend forbidden',
      },
    ];
    const producerEvidence = readEvidenceWaiverProducerEvidence(
      '/operator-stage-waiver.json',
      () => ({
        schema: 'operator-stage-waiver/v1',
        stage: 'architectural-review',
        sourceRevision,
        missingSlots: ['02', '03'],
      }),
      {
        stage: 'architectural-review',
        sourceRevision,
        missingSlots: partialMissingSources.map((item) => item.reviewerSlot),
      },
    );
    const invocations = ['01', '02', '03'].map((slot) => ({
      schema: 'reviewer-invocation-envelope/v1',
      reviewEpisodeId,
      stageAttemptId,
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: routing.cardinalityConfigIdentity,
      stage: 'architectural-review',
      sourceRevision,
      invocationId: 'invocation-' + slot,
      terminalResultIdentity: 'terminal-' + slot,
      reviewerSource: 'source-' + slot,
      reviewerSlot: slot,
      reviewerOrdinal: Number(slot),
      attemptOrdinal: 1,
      retryAttempt: false,
      terminal: true,
      terminalClassification: slot === '01' ? 'complete' : 'incident',
      sendCount: 1,
      retryClass: 'retry-forbidden',
      revisionCheck: 'matched',
      capacityOutcome: 'admitted',
      capacityWaitMs: 0,
      reviewLaneRouting: routing,
      ...(slot === '01' ? { capture } : {}),
    }));
    const stageReceipt = {
      schema: 'stage-completeness-receipt/v1',
      tier: 'T3',
      taskIdentity,
      episodeFirstRevision: sourceRevision,
      reviewEpisodeId,
      stageReceiptId,
      previousStageReceiptId: null,
      receiptCensus: [stageReceiptId],
      stageAttemptId,
      stageSequence: 1,
      stage: 'architectural-review',
      policyVersion: 'review-lane-routing/v1',
      reviewerCardinality: 3,
      cardinalityConfigIdentity: routing.cardinalityConfigIdentity,
      sourceRevision,
      outcome: 'partial',
      producerEvidence,
      partialMissingSources,
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      invocations,
      credentialingCaptures: [capture],
      relayEligibleCaptures: [capture],
      reviewLane,
    };
    const verifiedRelayEvidence = [{
      relayAttemptId: 'relay-01',
      captureIdentity,
      sourceLabel: captureName + '|' + captureIdentity,
      name: captureName,
      byteLength: capture.byteLength,
      sha256: capture.sha256,
      verified: true,
    }];
    const episodeAuthority = {
      tierIntake: {
        schema: 'tier-intake/v1',
        producer: 'test',
        taskIdentity,
        kind: 'fresh',
        priorTier: 'T3',
        firstRevision: sourceRevision,
        competitiveDecision: 'skipped',
        competitiveRationale: 'Issue #1778 locks the already-landed exact operator waiver at the ledger consumer.',
      },
      receiptInventory: {
        source: 'canonical-review-directory',
        taskIdentity,
        episodeFirstRevision: sourceRevision,
        reviewEpisodeId,
        stageReceiptIds: [stageReceiptId],
      },
    };
    const options = {
      reviewEconomics: true,
      phase: 'pre-lens',
      issueRevision: sourceRevision,
      stageTerminalConfirmed: true,
      captureMetadata: [{ name: captureName, timestampMs: 1_100, captureIdentity }],
      stageReceipts: [stageReceipt],
      verifiedRelayEvidence,
      episodeAuthority,
    };
    const emptyLedger = JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 0, distinctFindingCount: 0, processedDistinctCount: 0 },
      findings: [],
    });
    return {
      captureText,
      capture,
      reviewLane,
      stageReceipt,
      verifiedRelayEvidence,
      episodeAuthority,
      options,
      emptyLedger,
    };
  }

  function finalAcceptanceWaiverFixture(reviewCaptureText = markedClean()) {
    const base = waivedArchitecturalReviewFixture(reviewCaptureText);
    const sourceRevision = base.stageReceipt.sourceRevision;
    const reviewEpisodeId = base.stageReceipt.reviewEpisodeId;
    const lensReceiptId = reviewEpisodeId + ':stage-receipt:0002';
    const terminalReceiptId = reviewEpisodeId + ':stage-receipt:0003';
    const terminalText = markedClean();
    const terminalSha256 = createHash('sha256').update(terminalText).digest('hex');
    const terminalCapture = {
      captureIdentity: 'sha256:' + terminalSha256 + ':pass-03-architectural.capture.txt',
      name: 'pass-03-architectural.capture.txt',
      byteLength: Buffer.byteLength(terminalText),
      sha256: terminalSha256,
      rawFindingCount: 0,
    };
    const lensReceipt = {
      schema: 'stage-completeness-receipt/v1', tier: 'T3',
      taskIdentity: base.stageReceipt.taskIdentity, episodeFirstRevision: base.stageReceipt.episodeFirstRevision,
      reviewEpisodeId, stageReceiptId: lensReceiptId, previousStageReceiptId: base.stageReceipt.stageReceiptId,
      receiptCensus: [base.stageReceipt.stageReceiptId, lensReceiptId],
      stageAttemptId: 'attempt-lens', stageSequence: 2, stage: 'architectural-lens',
      policyVersion: 'single-source/v1', reviewerCardinality: 1,
      cardinalityConfigIdentity: base.stageReceipt.cardinalityConfigIdentity, sourceRevision, outcome: 'complete',
      producerEvidence: 'waived', partialMissingSources: [],
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      claude: { kind: 'waiver', waiver: { reason: 'claude-unavailable', unavailability: 'provider-unavailable', evidenceIdentity: 'claude-unavailable-1779' } },
      credentialingCaptures: [], relayEligibleCaptures: [],
    };
    const terminalReceipt = {
      schema: 'stage-completeness-receipt/v1', tier: 'T3',
      taskIdentity: base.stageReceipt.taskIdentity, episodeFirstRevision: base.stageReceipt.episodeFirstRevision,
      reviewEpisodeId, stageReceiptId: terminalReceiptId, previousStageReceiptId: lensReceiptId,
      receiptCensus: [base.stageReceipt.stageReceiptId, lensReceiptId, terminalReceiptId],
      stageAttemptId: 'attempt-terminal', stageSequence: 3, stage: 'architectural',
      policyVersion: 'single-source/v1', reviewerCardinality: 1,
      cardinalityConfigIdentity: base.stageReceipt.cardinalityConfigIdentity, sourceRevision, outcome: 'complete',
      producerEvidence: 'not-applicable', partialMissingSources: [],
      revisionChecks: { attemptCreation: 'matched', beforeLaunch: 'matched', settlement: 'matched' },
      settlement: { allLaunchedTerminal: true, retryState: 'none', finalRevisionMatched: true },
      invocations: [{
        schema: 'reviewer-invocation-envelope/v1', reviewEpisodeId, stageAttemptId: 'attempt-terminal',
        policyVersion: 'single-source/v1', reviewerCardinality: 1,
        cardinalityConfigIdentity: base.stageReceipt.cardinalityConfigIdentity, stage: 'architectural', sourceRevision,
        invocationId: 'terminal-invocation-1779', terminalResultIdentity: 'terminal-result-1779',
        reviewerSource: 'source-terminal-1779', reviewerSlot: '01', reviewerOrdinal: 1, attemptOrdinal: 1,
        retryAttempt: false, terminal: true, terminalClassification: 'complete', sendCount: 1, retryClass: 'none',
        revisionCheck: 'matched', capacityOutcome: 'admitted', capacityWaitMs: 0, capture: terminalCapture,
      }],
      credentialingCaptures: [terminalCapture], relayEligibleCaptures: [terminalCapture],
    };
    const stageReceipts = [base.stageReceipt, lensReceipt, terminalReceipt];
    const texts = [base.captureText, terminalText];
    const captures = [base.capture, terminalCapture];
    const verifiedRelayEvidence = captures.map((capture, index) => ({
      relayAttemptId: 'relay-final-' + (index + 1), captureIdentity: capture.captureIdentity,
      sourceLabel: capture.name + '|' + capture.captureIdentity, name: capture.name,
      byteLength: capture.byteLength, sha256: capture.sha256, verified: true,
    }));
    const episodeAuthority = {
      ...base.episodeAuthority,
      receiptInventory: { ...base.episodeAuthority.receiptInventory, stageReceiptIds: stageReceipts.map((receipt) => receipt.stageReceiptId) },
    };
    const options = {
      ...base.options, phase: 'final-acceptance',
      captureMetadata: captures.map((capture, index) => ({ name: capture.name, timestampMs: 1_100 + index * 200, captureIdentity: capture.captureIdentity })),
      stageReceipts, verifiedRelayEvidence, episodeAuthority,
    };
    return { ...base, terminalCapture, terminalReceipt, lensReceipt, stageReceipts, texts, captures, verifiedRelayEvidence, episodeAuthority, options };
  }

  it('accepts full T3 final acceptance regardless of legacy remote-authority provenance inputs', () => {
    const fixture = finalAcceptanceWaiverFixture();
    for (const legacyOptions of [
      {},
      { remoteAuthority: { schema: 'stale-remote-authority/v0' } },
      { remoteAuthorities: [{ schema: 'mismatched-remote-authority/v0', stage: 'competitive' }] },
      { requireRemoteAuthority: true },
      { requireRemoteAuthority: true, remoteAuthorities: [{ schema: 'stale-remote-authority/v0' }] },
    ]) {
      const result = checkFindingLedgerGuard(
        fixture.texts,
        fixture.emptyLedger,
        { ...fixture.options, ...legacyOptions } as never,
      );
      expect(result.ok, result.errors.join('\n')).toBe(true);
    }
  });

  it('keeps terminal architectural evidence mandatory after the positive final-acceptance fixture passes', () => {
    const fixture = finalAcceptanceWaiverFixture();
    const baseline = checkFindingLedgerGuard(fixture.texts, fixture.emptyLedger, fixture.options as never);
    expect(baseline.ok, baseline.errors.join('\n')).toBe(true);

    const remainingReceipts = fixture.stageReceipts.slice(0, 2);
    const missingTerminal = checkFindingLedgerGuard(
      fixture.texts.slice(0, 1),
      fixture.emptyLedger,
      {
        ...fixture.options,
        captureMetadata: fixture.options.captureMetadata.slice(0, 1),
        stageReceipts: remainingReceipts,
        verifiedRelayEvidence: fixture.verifiedRelayEvidence.slice(0, 1),
        episodeAuthority: {
          ...fixture.episodeAuthority,
          receiptInventory: {
            ...fixture.episodeAuthority.receiptInventory,
            stageReceiptIds: remainingReceipts.map((receipt) => receipt.stageReceiptId),
          },
        },
      } as never,
    );
    expect(missingTerminal.ok).toBe(false);
    expect(missingTerminal.errors.join('\n')).toContain(
      'architectural requires exactly one credentialing complete-or-proven-partial stageAttemptId in the review episode',
    );
  });

  it('keeps unresolved governed defects blocking at final acceptance without provenance errors', () => {
    const findingText = markedFinding('WAIVER-FINAL-F1', {
      type: 'quality',
      evidence: 'The real slot-01 review found a material defect.',
    });
    const fixture = finalAcceptanceWaiverFixture(findingText);
    const ledger = JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 0 },
      findings: [row('WAIVER-FINAL-F1', {
        defectDisposition: 'unresolved',
        remedyDisposition: 'accepted',
        occurrences: [fixture.capture.captureIdentity + ':1'],
      })],
    });
    const result = checkFindingLedgerGuard(
      fixture.texts,
      ledger,
      { ...fixture.options, requireRemoteAuthority: true } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('row WAIVER-FINAL-F1 remains unresolved');
    expect(result.errors.join('\n')).not.toContain('remote authority');
  });

  it('does not open or parse supplied --remote-authority paths on the final-acceptance CLI path', () => {
    const fixture = finalAcceptanceWaiverFixture();
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'finding-ledger-1779-'));
    const previousStateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
    const canonical = path.join(stateRoot, '.review', '1779');
    try {
      process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = stateRoot;
      mkdirSync(canonical, { recursive: true });
      const intakePath = path.join(canonical, 'tier-intake.json');
      const ledgerPath = path.join(canonical, 'finding-disposition-ledger.json');
      const relayPath = path.join(canonical, 'verified-relay-evidence.json');
      writeFileSync(intakePath, JSON.stringify(fixture.episodeAuthority.tierIntake));
      writeFileSync(ledgerPath, fixture.emptyLedger);
      writeFileSync(relayPath, JSON.stringify(fixture.verifiedRelayEvidence));
      fixture.stageReceipts.forEach((receipt, index) => {
        writeFileSync(path.join(canonical, 'stage-completeness-receipt-' + (index + 1) + '.json'), JSON.stringify(receipt));
      });
      fixture.captures.forEach((capture, index) => {
        writeFileSync(path.join(canonical, capture.name), fixture.texts[index]);
      });

      const argv = [
        'node', 'scripts/finding-ledger-guard.mjs',
        '--ledger', ledgerPath,
        '--captures-dir', canonical,
        '--phase', 'final-acceptance',
        '--adoption-timestamp', '0',
        '--issue-revision', fixture.stageReceipt.sourceRevision,
        '--stage-terminal',
        '--receipt-directory', canonical,
        '--tier-intake', intakePath,
        '--verified-relay-evidence', relayPath,
      ];
      expect(runCli(argv)).toBe(0);

      const stalePath = path.join(stateRoot, 'stale-remote-authority.json');
      const malformedPath = path.join(stateRoot, 'malformed-remote-authority.json');
      const nonexistentPath = path.join(stateRoot, 'nonexistent-remote-authority.json');
      writeFileSync(stalePath, JSON.stringify({ schema: 'mismatched-remote-authority/v0' }));
      writeFileSync(malformedPath, '{');
      expect(runCli([...argv, '--remote-authority', stalePath])).toBe(0);
      expect(runCli([...argv, '--remote-authority', malformedPath])).toBe(0);
      expect(runCli([...argv, '--remote-authority', nonexistentPath])).toBe(0);
      expect(runCli([...argv, '--remote-authority'])).toBe(1);
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT;
      else process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT = previousStateRoot;
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('locks current-main receipt-backed waiver acceptance with only the real slot-01 governed capture', () => {
    const fixture = waivedArchitecturalReviewFixture();
    expect(fixture.stageReceipt.producerEvidence).toBe('waived');

    const result = checkFindingLedgerGuard(
      [fixture.captureText],
      fixture.emptyLedger,
      fixture.options as never,
    );

    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(result.episodeState?.errors).toEqual([]);
    expect(result.episodeState?.governedCaptureUnion).toEqual([fixture.capture.captureIdentity]);
    expect(result.episodeState?.governedCaptures).toEqual([fixture.capture]);
    expect(result.episodeState?.governedCaptures.map((capture) => capture.name)).toEqual([
      'pass-01-architectural-review-01.capture.txt',
    ]);
  });

  it('keeps missing mandatory results blocking outside the exact waived 02/03 absence', () => {
    const fixture = waivedArchitecturalReviewFixture();

    const noWaiverOptions = {
      ...fixture.options,
      stageReceipts: [{ ...fixture.stageReceipt, producerEvidence: 'not-applicable' }],
    };
    const noWaiverResult = checkFindingLedgerGuard(
      [fixture.captureText],
      fixture.emptyLedger,
      noWaiverOptions as never,
    );
    expect(noWaiverResult.ok).toBe(false);
    expect(noWaiverResult.errors.join('\n')).toContain('stage receipt[0] reviewLane must be complete immutable evidence');

    const wrongMissingOptions = {
      ...fixture.options,
      stageReceipts: [{
        ...fixture.stageReceipt,
        partialMissingSources: [fixture.stageReceipt.partialMissingSources[0]],
      }],
    };
    const wrongMissingResult = checkFindingLedgerGuard(
      [fixture.captureText],
      fixture.emptyLedger,
      wrongMissingOptions as never,
    );
    expect(wrongMissingResult.ok).toBe(false);
    expect(wrongMissingResult.errors.join('\n')).toContain('stage receipt[0] reviewLane must be complete immutable evidence');

    const missingSlotOneReceipt = {
      ...fixture.stageReceipt,
      invocations: fixture.stageReceipt.invocations.map((invocation, index) => index === 0
        ? { ...invocation, capture: undefined, terminalClassification: 'incident' }
        : invocation),
      credentialingCaptures: [],
      relayEligibleCaptures: [],
      reviewLane: {
        ...fixture.reviewLane,
        sourceVerdicts: {},
        sourceVerdictEvidence: {},
      },
    };
    const missingSlotOneOptions = {
      ...fixture.options,
      captureMetadata: [],
      stageReceipts: [missingSlotOneReceipt],
      verifiedRelayEvidence: [],
    };
    const missingSlotOneResult = checkFindingLedgerGuard([], fixture.emptyLedger, missingSlotOneOptions as never);
    expect(missingSlotOneResult.ok).toBe(false);
    expect(missingSlotOneResult.errors.join('\n')).toContain('stage receipt[0] reviewLane must be complete immutable evidence');

    const missingRequiredStageOptions = {
      ...fixture.options,
      episodeAuthority: {
        ...fixture.episodeAuthority,
        tierIntake: {
          ...fixture.episodeAuthority.tierIntake,
          competitiveDecision: 'required',
          competitiveRationale: 'This fixture deliberately declares the competitive result required.',
        },
      },
    };
    const missingRequiredStageResult = checkFindingLedgerGuard(
      [fixture.captureText],
      fixture.emptyLedger,
      missingRequiredStageOptions as never,
    );
    expect(missingRequiredStageResult.ok).toBe(false);
    expect(missingRequiredStageResult.errors.join('\n')).toContain('competitive');
  });

  it('keeps a real unresolved slot-01 finding blocking under the valid operator waiver', () => {
    const findingText = markedFinding('WAIVER-F1', {
      type: 'quality',
      evidence: 'The real slot-01 review found a material defect.',
    });
    const fixture = waivedArchitecturalReviewFixture(findingText);
    const occurrenceId = fixture.capture.captureIdentity + ':1';
    const ledger = JSON.stringify({
      version: 2,
      counts: { rawFindingCount: 1, distinctFindingCount: 1, processedDistinctCount: 0 },
      findings: [row('WAIVER-F1', {
        defectDisposition: 'unresolved',
        remedyDisposition: 'accepted',
        occurrences: [occurrenceId],
      })],
    });

    const result = checkFindingLedgerGuard([findingText], ledger, fixture.options as never);

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('row WAIVER-F1 remains unresolved');
  });

  it('keeps real governed slot-01 immutable capture integrity fail-closed', () => {
    const fixture = waivedArchitecturalReviewFixture();

    const tamperedBytes = checkFindingLedgerGuard(
      [fixture.captureText + '\n'],
      fixture.emptyLedger,
      fixture.options as never,
    );
    expect(tamperedBytes.ok).toBe(false);
    expect(tamperedBytes.errors.join('\n')).toContain('byteLength mismatch');
    expect(tamperedBytes.errors.join('\n')).toContain('sha256 mismatch');

    const badShaCapture = { ...fixture.capture, sha256: 'f'.repeat(64) };
    const badShaReceipt = {
      ...fixture.stageReceipt,
      invocations: fixture.stageReceipt.invocations.map((invocation, index) => index === 0
        ? { ...invocation, capture: badShaCapture }
        : invocation),
      credentialingCaptures: [badShaCapture],
      relayEligibleCaptures: [badShaCapture],
    };
    const badShaOptions = {
      ...fixture.options,
      stageReceipts: [badShaReceipt],
      verifiedRelayEvidence: [{ ...fixture.verifiedRelayEvidence[0], sha256: 'f'.repeat(64) }],
    };
    const badSha = checkFindingLedgerGuard([fixture.captureText], fixture.emptyLedger, badShaOptions as never);
    expect(badSha.ok).toBe(false);
    expect(badSha.errors.join('\n')).toContain('sha256 mismatch');

    const badCountCapture = { ...fixture.capture, rawFindingCount: 1 };
    const badCountReceipt = {
      ...fixture.stageReceipt,
      invocations: fixture.stageReceipt.invocations.map((invocation, index) => index === 0
        ? { ...invocation, capture: badCountCapture }
        : invocation),
      credentialingCaptures: [badCountCapture],
      relayEligibleCaptures: [badCountCapture],
    };
    const badCountOptions = {
      ...fixture.options,
      stageReceipts: [badCountReceipt],
    };
    const badCount = checkFindingLedgerGuard([fixture.captureText], fixture.emptyLedger, badCountOptions as never);
    expect(badCount.ok).toBe(false);
    expect(badCount.errors.join('\n')).toContain('rawFindingCount mismatch');

    const omittedTextOptions = {
      ...fixture.options,
      captureMetadata: [],
    };
    const omittedText = checkFindingLedgerGuard([], fixture.emptyLedger, omittedTextOptions as never);
    expect(omittedText.ok).toBe(false);
    expect(omittedText.errors.join('\n')).toContain('has no supplied immutable text');
  });
});

