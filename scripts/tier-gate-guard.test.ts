import { describe, expect, it } from 'vitest';
import {
  PRE_1142_COMPLETED_DEMOTION_IDENTITIES,
  checkTierGateGuard,
  parseComplexityTierFence,
  parseDecisionReceipt,
  parseIntakeRecord,
  selectAuthoringReviewStages,
  type LegacyDemotionEventRecord,
  type LegacyDemotionRevalidationRecord,
  type Tier,
  type TierDecisionReceiptRecord,
  type TierTransitionEvidence,
} from './lib/tier-gate-core.ts';

const identity = '1142-fixture';

function draft(
  tier: Tier,
  prior: Tier,
  options: { behavior?: 'record-only' | 'action-producing'; riskNote?: string; legacyFence?: boolean } = {},
): string {
  const behavior = options.behavior ?? 'record-only';
  const positive = behavior === 'action-producing'
    ? '\n```positive-outcome\nasserts: emits a deterministic result\ninput: realistic\n```\n'
    : '';
  const risk = options.riskNote ? `\nrisk-note: ${options.riskNote}` : '';
  const legacy = options.legacyFence ? '\ndemotion-from: T3\ndemotion-event: old-1' : '';
  return `# Fixture\n\n## Goal\nExercise tier behavior.\n\n\`\`\`behavior-kind\n${behavior}\n\`\`\`${positive}\n\`\`\`complexity-tier\ntier: ${tier}\nadvisory-prior: ${prior}${risk}${legacy}\n\`\`\`\n\n\`\`\`denylist\nvendor/**\npackages/core/**\n\`\`\`\n\n\`\`\`allowed-roots\ndocs/example.md\n\`\`\`\n\n## Acceptance criteria\n1. The fixture is deterministic.\n\n## Verification\nRun the focused test.\n\n\`\`\`contract-evidence\nnone\n\`\`\`\n`;
}

function receipt(
  revision: string,
  tier: Tier,
  options: Partial<TierDecisionReceiptRecord> = {},
): TierDecisionReceiptRecord {
  return {
    schema: 'tier-gate-decision/v1',
    producer: options.producer ?? 'cursor-flow-manager',
    revision,
    tier,
    rubricClasses: options.rubricClasses ?? [
      tier === 'T3'
        ? 'failure-type:subsystem-or-system-guarantee'
        : tier === 'T2'
          ? 'failure-type:local-behavior'
          : 'failure-type:text-cosmetics',
    ],
    l4Status: options.l4Status ?? (tier === 'T3' ? 'clear' : 'not-applicable'),
    ...(options.correctedFrom ? { correctedFrom: options.correctedFrom } : {}),
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };
}

function evidence(
  revisions: TierTransitionEvidence['revisions'],
  options: Partial<Omit<TierTransitionEvidence, 'taskIdentity' | 'revisions'>> & {
    priorTier?: Tier;
    intakeKind?: 'fresh' | 'compatibility';
    taskIdentity?: string;
  } = {},
): TierTransitionEvidence {
  const taskIdentity = options.taskIdentity ?? identity;
  return {
    taskIdentity,
    currentRevision: options.currentRevision ?? revisions.at(-1)?.revision ?? '',
    intake: options.intake === undefined
      ? {
          schema: 'tier-intake/v1',
          producer: 'cursor-flow-manager',
          taskIdentity,
          kind: options.intakeKind ?? 'fresh',
          priorTier: options.priorTier ?? revisions[0]?.tier ?? 'T3',
          firstRevision: revisions[0]?.revision ?? 'r01',
        }
      : options.intake,
    revisions,
    events: options.events ?? [],
    revalidations: options.revalidations ?? [],
    captures: options.captures ?? [],
  };
}

function run(text: string, transitionEvidence: TierTransitionEvidence, legacy: readonly string[] = []) {
  return checkTierGateGuard(text, {
    repoRoot: process.cwd(),
    transitionEvidence,
    completedLegacyDemotionIdentities: legacy,
  });
}

function correction(
  before: Tier = 'T3',
  after: Tier = 'T2',
  options: { reason?: string; captures?: TierTransitionEvidence['captures']; middle?: Tier } = {},
) {
  const first = draft(before, before);
  const revisions: TierTransitionEvidence['revisions'] = [
    { revision: 'r01', text: first, tier: before, receipt: receipt('r01', before) },
  ];
  if (options.middle) {
    const middle = draft(options.middle, before);
    revisions.push({ revision: 'r02', text: middle, tier: options.middle, receipt: receipt('r02', options.middle) });
  }
  const revision = options.middle ? 'r03' : 'r02';
  const current = draft(after, before);
  revisions.push({
    revision,
    text: current,
    tier: after,
    receipt: receipt(revision, after, { correctedFrom: before, reason: options.reason ?? 'r01 prior was over-tiered.' }),
  });
  return { current, transitionEvidence: evidence(revisions, { priorTier: before, captures: options.captures ?? [] }) };
}

describe('Issue #1142 receipt parsing and L4 matrix', () => {
  it('preserves arbitrary non-empty producer labels and rejects blank labels', () => {
    for (const producer of ['cursor-flow-manager', 'codex-flow-manager', 'future-runtime']) {
      expect(parseIntakeRecord({ schema: 'tier-intake/v1', producer, taskIdentity: identity, kind: 'fresh', priorTier: 'T2', firstRevision: 'r01' })?.producer).toBe(producer);
      expect(parseDecisionReceipt({ schema: 'tier-gate-decision/v1', producer, revision: 'r01', tier: 'T2', rubricClasses: ['failure-type:local-behavior'], l4Status: 'not-applicable' })?.producer).toBe(producer);
    }
    expect(parseIntakeRecord({ schema: 'tier-intake/v1', producer: ' ', taskIdentity: identity, kind: 'fresh', priorTier: 'T2', firstRevision: 'r01' })).toBeNull();
  });

  it('enforces the complete tier/status matrix and normalizes legacy below-T3 clear', () => {
    for (const tier of ['T1', 'T2'] as const) {
      expect(parseDecisionReceipt({ schema: 'tier-gate-decision/v1', producer: 'x', revision: 'r01', tier, rubricClasses: ['failure-type:local-behavior'], l4Status: 'not-applicable' })?.l4Status).toBe('not-applicable');
      const legacy = parseDecisionReceipt({ schema: 'tier-gate-decision/v1', producer: 'x', revision: 'r01', tier, rubricClasses: ['failure-type:local-behavior'], l4Status: 'clear' });
      expect(legacy?.l4Status).toBe('not-applicable');
      expect(legacy?.legacyL4Status).toBe('clear');
      for (const invalid of ['active', 'ambiguous', 'missing', 'stale']) {
        expect(parseDecisionReceipt({ schema: 'tier-gate-decision/v1', producer: 'x', revision: 'r01', tier, rubricClasses: ['failure-type:local-behavior'], l4Status: invalid })).toBeNull();
      }
    }
    for (const valid of ['clear', 'active', 'ambiguous', 'missing', 'stale']) {
      expect(parseDecisionReceipt({ schema: 'tier-gate-decision/v1', producer: 'x', revision: 'r01', tier: 'T3', rubricClasses: ['failure-type:subsystem-or-system-guarantee'], l4Status: valid })?.l4Status).toBe(valid);
    }
    expect(parseDecisionReceipt({ schema: 'tier-gate-decision/v1', producer: 'x', revision: 'r01', tier: 'T3', rubricClasses: ['failure-type:subsystem-or-system-guarantee'], l4Status: 'not-applicable' })).toBeNull();
  });

  it('keeps T1 and T2 on the same one-terminal-architectural review pipeline', () => {
    expect(selectAuthoringReviewStages({ tier: 'T1', skipLine: false }).review).toEqual(['architectural']);
    expect(selectAuthoringReviewStages({ tier: 'T2', skipLine: false }).review).toEqual(['architectural']);
  });
});

describe('Issue #1142 free pre-capture adjacent correction', () => {
  it('accepts r01 T3 to r02 T2 without demotion event or revalidation', () => {
    const fixture = correction();
    const result = run(fixture.current, fixture.transitionEvidence);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('does not treat advisory prior or a pre-capture high watermark as a floor', () => {
    const fixture = correction('T2', 'T1');
    expect(run(fixture.current, fixture.transitionEvidence).ok).toBe(true);
  });

  it('rejects direct T3 to T1, a blank reason, and a second downstep', () => {
    const direct = correction('T3', 'T1');
    expect(run(direct.current, direct.transitionEvidence).errors.join('\n')).toContain('only one adjacent tier edge');

    const blank = correction('T3', 'T2', { reason: '   ' });
    expect(run(blank.current, blank.transitionEvidence).errors.join('\n')).toContain('non-empty reason');

    const r01 = draft('T3', 'T3');
    const r02 = draft('T2', 'T3');
    const r03 = draft('T1', 'T3');
    const two = evidence([
      { revision: 'r01', text: r01, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: r02, tier: 'T2', receipt: receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'over-tiered' }) },
      { revision: 'r03', text: r03, tier: 'T1', receipt: receipt('r03', 'T1', { correctedFrom: 'T2', reason: 'still over-tiered' }) },
    ]);
    expect(run(r03, two).errors.join('\n')).toContain('only one intake downstep');
  });

  it('rejects correction after a selected canonical reviewer capture', () => {
    const fixture = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-competitive.capture.txt', captureText: 'issue_revision: r01\nNO_FINDINGS' }],
    });
    expect(run(fixture.current, fixture.transitionEvidence).errors.join('\n')).toContain('already closed');
  });

  it('accepts a capture bound to the corrected revision because the receipt existed first', () => {
    const fixture = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-architectural.capture.txt', captureText: 'issue_revision: r02\nNO_FINDINGS' }],
    });
    const result = run(fixture.current, fixture.transitionEvidence);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('fails closed on unbound capture, replayed history, and correction after an upstep', () => {
    const unbound = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-competitive.capture.txt', captureText: 'NO_FINDINGS' }],
    });
    expect(run(unbound.current, unbound.transitionEvidence).errors.join('\n')).toContain('lacks one immutable');

    const replay = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-competitive.capture.txt', captureText: 'issue_revision: r99' }],
    });
    expect(run(replay.current, replay.transitionEvidence).errors.join('\n')).toContain('outside this Issue history');

    const upstep = correction('T2', 'T1', { middle: 'T3' });
    expect(run(upstep.current, upstep.transitionEvidence).errors.join('\n')).toContain('intervening upstep');
  });

  it('rejects retired demotion fence fields for a fresh task', () => {
    const current = draft('T2', 'T3', { legacyFence: true });
    const transitionEvidence = evidence([
      { revision: 'r01', text: draft('T3', 'T3'), tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: current, tier: 'T2', receipt: receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'over-tiered' }) },
    ]);
    expect(run(current, transitionEvidence).errors.join('\n')).toContain('retired demotion fence fields');
  });
});

describe('Issue #1142 frozen read-old/write-none compatibility', () => {
  const legacyIdentity = 'completed-old-transition';
  const event: LegacyDemotionEventRecord = {
    schema: 'tier-demotion-event/v1', eventId: 'old-1', kind: 'compatibility', sourceRevision: 'r01', beforeTier: 'T3', afterTier: 'T2',
  };
  const revalidation: LegacyDemotionRevalidationRecord = {
    schema: 'tier-demotion-revalidation/v1', eventId: 'old-1', candidateRevision: 'r02', beforeTier: 'T3', afterTier: 'T2',
  };

  function legacyFixture(extra = false): { current: string; transitionEvidence: TierTransitionEvidence } {
    const source = draft('T3', 'T3');
    const candidate = draft('T2', 'T3', { legacyFence: true });
    const revisions: TierTransitionEvidence['revisions'] = [
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: candidate, tier: 'T2', receipt: parseDecisionReceipt({ schema: 'tier-gate-decision/v1', producer: 'cursor-flow-manager', revision: 'r02', tier: 'T2', rubricClasses: ['failure-type:local-behavior'], l4Status: 'clear' }) },
    ];
    if (extra) revisions.push({ revision: 'r03', text: candidate, tier: 'T2', receipt: receipt('r03', 'T2') });
    return {
      current: candidate,
      transitionEvidence: evidence(revisions, {
        taskIdentity: legacyIdentity,
        currentRevision: extra ? 'r03' : 'r02',
        intakeKind: 'compatibility',
        priorTier: 'T3',
        events: [{ record: event, captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'legacy' }],
        revalidations: [{ record: revalidation, captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'legacy' }],
      }),
    };
  }

  it('ships an empty production census and validates an explicitly injected complete transition', () => {
    expect(PRE_1142_COMPLETED_DEMOTION_IDENTITIES).toEqual([]);
    const fixture = legacyFixture();
    const result = run(fixture.current, fixture.transitionEvidence, [legacyIdentity]);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('rejects a new identity, partial chain, and later candidate', () => {
    const freshIdentity = legacyFixture();
    expect(run(freshIdentity.current, freshIdentity.transitionEvidence).errors.join('\n')).toContain('compatibility intake');

    const partial = legacyFixture();
    partial.transitionEvidence.revalidations = [];
    expect(run(partial.current, partial.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('exactly one completed');

    const later = legacyFixture(true);
    expect(run(later.current, later.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('existing current lower-tier candidate');
  });
});

describe('Issue #1142 record-only, L4, and risk-note shapes', () => {
  it('classifies a #1135-shaped record-only task below T3 with L4 not-applicable', () => {
    const current = draft('T1', 'T1');
    const transitionEvidence = evidence([{ revision: 'r01', text: current, tier: 'T1', receipt: receipt('r01', 'T1') }], { priorTier: 'T1' });
    expect(run(current, transitionEvidence).ok).toBe(true);

    const invalid = draft('T3', 'T3');
    const invalidEvidence = evidence([{ revision: 'r01', text: invalid, tier: 'T3', receipt: receipt('r01', 'T3') }], { priorTier: 'T3' });
    expect(run(invalid, invalidEvidence).errors.join('\n')).toContain('record-only work cannot be T3');
  });

  it('keeps a #1120-shaped action-producing task at T3 with active L4', () => {
    const current = draft('T3', 'T3', { behavior: 'action-producing' });
    const transitionEvidence = evidence([{ revision: 'r01', text: current, tier: 'T3', receipt: receipt('r01', 'T3', { l4Status: 'active' }) }], { priorTier: 'T3' });
    const result = run(current, transitionEvidence);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });

  it('accepts optional risk-note without changing tier or stages', () => {
    const current = draft('T2', 'T2', { riskNote: 'Touches operator-visible reporting only.' });
    const transitionEvidence = evidence([{ revision: 'r01', text: current, tier: 'T2', receipt: receipt('r01', 'T2') }], { priorTier: 'T2' });
    const result = run(current, transitionEvidence);
    expect(result.ok, result.errors.join('\n')).toBe(true);
    expect(parseComplexityTierFence(current)).toMatchObject({ riskNote: 'Touches operator-visible reporting only.' });
    expect(result.stages.review).toEqual(['architectural']);
  });
});
