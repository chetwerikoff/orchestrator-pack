import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRE_973_CUTOVER_WORKDIR_IDENTITIES,
  PRE_973_HISTORICAL_DEMOTIONS,
  checkTierGateGuard,
  parseComplexityTierFence,
  type TierDecisionReceiptRecord,
  type TierDemotionEventRecord,
  type TierDemotionRevalidationRecord,
  type TierTransitionEvidence,
} from './lib/tier-gate-core.ts';

type Tier = 'T1' | 'T2' | 'T3';

const identity = '973-fixture';

function draft(
  tier: Tier,
  advisoryPrior: Tier,
  opts: { demotionFrom?: Tier; demotionEvent?: string; body?: string } = {},
): string {
  const demotion = opts.demotionFrom && opts.demotionEvent
    ? `\ndemotion-from: ${opts.demotionFrom}\ndemotion-event: ${opts.demotionEvent}`
    : '';
  return `# Fixture\n\n## Goal\n${opts.body ?? 'Describe one local behavior.'}\n\n\`\`\`behavior-kind\nrecord-only\n\`\`\`\n\n\`\`\`complexity-tier\ntier: ${tier}\nadvisory-prior: ${advisoryPrior}${demotion}\n\`\`\`\n\n\`\`\`denylist\nvendor/**\npackages/core/**\n\`\`\`\n\n\`\`\`allowed-roots\ndocs/example.md\n\`\`\`\n\n## Acceptance criteria\n1. The fixture is accepted.\n\n## Verification\nRun the focused fixture.\n\n\`\`\`contract-evidence\nnone\n\`\`\`\n`;
}

function receipt(
  revision: string,
  tier: Tier,
  opts: Partial<Pick<TierDecisionReceiptRecord, 'markerRows' | 'rubricClasses' | 'l4Status'>> = {},
): TierDecisionReceiptRecord {
  return {
    schema: 'tier-gate-decision/v1',
    producer: 'cursor-flow-manager',
    revision,
    tier,
    markerRows: opts.markerRows ?? [],
    rubricClasses: opts.rubricClasses ?? [
      tier === 'T3'
        ? 'failure-type:subsystem-or-system-guarantee'
        : tier === 'T2'
          ? 'failure-type:local-behavior'
          : 'failure-type:text-cosmetics',
    ],
    l4Status: opts.l4Status ?? 'clear',
  };
}

function event(overrides: Partial<TierDemotionEventRecord> = {}): TierDemotionEventRecord {
  return {
    schema: 'tier-demotion-event/v1',
    eventId: 'demotion-1',
    kind: 'new',
    role: 'architect',
    stage: 'final-architect-lens',
    sourceRevision: 'r01',
    beforeTier: 'T3',
    afterTier: 'T2',
    drivers: [
      {
        kind: 'rubric',
        id: 'failure-type:subsystem-or-system-guarantee',
        rationale: 'The current change no longer changes a subsystem guarantee.',
      },
    ],
    ...overrides,
  };
}

function revalidation(
  candidateRevision: string,
  overrides: Partial<TierDemotionRevalidationRecord> = {},
): TierDemotionRevalidationRecord {
  return {
    schema: 'tier-demotion-revalidation/v1',
    eventId: 'demotion-1',
    role: 'architect',
    stage: 'final-architect-lens',
    candidateRevision,
    beforeTier: 'T3',
    afterTier: 'T2',
    l4Status: 'clear',
    ...overrides,
  };
}

function evidence(
  revisions: Array<{ revision: string; text: string; tier: Tier; receipt: TierDecisionReceiptRecord | null }>,
  opts: {
    currentRevision?: string;
    intakeKind?: 'fresh' | 'compatibility';
    priorTier?: Tier;
    firstRevision?: string;
    events?: TierTransitionEvidence['events'];
    revalidations?: TierTransitionEvidence['revalidations'];
    captures?: NonNullable<TierTransitionEvidence['captures']>;
    intake?: TierTransitionEvidence['intake'];
  } = {},
): TierTransitionEvidence {
  return {
    taskIdentity: identity,
    currentRevision: opts.currentRevision ?? revisions.at(-1)?.revision ?? '',
    intake: opts.intake === undefined
      ? {
          schema: 'tier-intake/v1',
          producer: 'cursor-flow-manager',
          taskIdentity: identity,
          kind: opts.intakeKind ?? 'fresh',
          priorTier: opts.priorTier ?? 'T3',
          firstRevision: opts.firstRevision ?? 'r01',
        }
      : opts.intake,
    revisions,
    events: opts.events ?? [],
    revalidations: opts.revalidations ?? [],
    captures: opts.captures ?? [],
  };
}

function run(
  text: string,
  transitionEvidence: TierTransitionEvidence,
  cutoverIdentities: string[] = [],
  historicalDemotionIdentities: string[] = [],
) {
  return checkTierGateGuard(text, {
    repoRoot: process.cwd(),
    transitionEvidence,
    cutoverIdentities,
    historicalDemotionIdentities,
  });
}

function validDemotionEvidence(currentRevision = 'r02'): {
  currentText: string;
  transitionEvidence: TierTransitionEvidence;
} {
  const sourceText = draft('T3', 'T3');
  const demotedText = draft('T2', 'T3', { demotionFrom: 'T3', demotionEvent: 'demotion-1' });
  const revisions = [
    { revision: 'r01', text: sourceText, tier: 'T3' as const, receipt: receipt('r01', 'T3') },
    { revision: 'r02', text: demotedText, tier: 'T2' as const, receipt: receipt('r02', 'T2') },
  ];
  if (currentRevision === 'r03') {
    revisions.push({ revision: 'r03', text: demotedText, tier: 'T2', receipt: receipt('r03', 'T2') });
  }
  const eventRecord = event();
  return {
    currentText: demotedText,
    transitionEvidence: evidence(revisions, {
      currentRevision,
      events: [{ record: eventRecord, captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens' }],
      revalidations: [{
        record: revalidation(currentRevision),
        captureName: 'pass-02-architectural-lens.capture.txt',
        captureText: 'architect final lens revalidation',
      }],
    }),
  };
}

describe('Issue #973 tier provenance', () => {
  it('parses stable demotion fence fields as a pair', () => {
    expect(parseComplexityTierFence(draft('T2', 'T3', {
      demotionFrom: 'T3',
      demotionEvent: 'demotion-1',
    }))).toMatchObject({ demotionFrom: 'T3', demotionEvent: 'demotion-1' });
    expect(parseComplexityTierFence(`\`\`\`complexity-tier\ntier: T2\ndemotion-from: T3\n\`\`\``)).toMatchObject({
      kind: 'unparseable',
    });
  });

  it('rejects an author-lowered first candidate against the manager-recorded fresh prior', () => {
    const text = draft('T2', 'T2');
    const result = run(text, evidence([
      { revision: 'r01', text, tier: 'T2', receipt: receipt('r01', 'T2') },
    ], { priorTier: 'T3' }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('advisory-prior does not match flow-manager intake prior');
    expect(result.errors.join('\n')).toContain('first authoritative candidate cannot be below intake prior');

    const later = run(text, evidence([
      { revision: 'r01', text, tier: 'T2', receipt: receipt('r01', 'T2') },
      { revision: 'r02', text, tier: 'T2', receipt: receipt('r02', 'T2') },
    ], { currentRevision: 'r02', priorTier: 'T3' }));
    expect(later.ok).toBe(false);
    expect(later.errors.join('\n')).toContain('first authoritative candidate cannot be below intake prior');
  });

  it('fails closed on missing intake evidence', () => {
    const text = draft('T2', 'T2');
    const result = run(text, evidence([
      { revision: 'r01', text, tier: 'T2', receipt: receipt('r01', 'T2') },
    ], { intake: null }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing flow-manager intake evidence');
  });

  it('loads the Issue-only workdir evidence and fails closed on malformed manager intake', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-973-'));
    try {
      const stem = '973-loader-fixture';
      const anchorDir = join(root, 'docs', 'issues_drafts');
      const reviewDir = join(anchorDir, '.review', stem);
      const revisionDir = join(root, 'r01');
      mkdirSync(reviewDir, { recursive: true });
      mkdirSync(revisionDir, { recursive: true });

      const text = draft('T2', 'T2');
      const anchor = join(anchorDir, `${stem}.md`);
      writeFileSync(anchor, text);
      writeFileSync(join(revisionDir, `${stem}.md`), text);
      writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(receipt('r01', 'T2')));
      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
        schema: 'tier-intake/v1',
        producer: 'browser-gpt',
        taskIdentity: stem,
        kind: 'fresh',
        priorTier: 'T2',
        firstRevision: 'r01',
      }));

      const malformed = checkTierGateGuard(text, {
        repoRoot: process.cwd(),
        draftPath: anchor,
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.errors.join('\n')).toContain('malformed flow-manager intake evidence');

      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
        schema: 'tier-intake/v1',
        producer: 'cursor-flow-manager',
        taskIdentity: stem,
        kind: 'fresh',
        priorTier: 'T2',
        firstRevision: 'r01',
      }));
      expect(checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath: anchor }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows compatibility intake only for a frozen-listed identity', () => {
    const text = draft('T2', 'T2');
    const ev = evidence([
      { revision: 'r01', text, tier: 'T2', receipt: receipt('r01', 'T2') },
    ], { intakeKind: 'compatibility', priorTier: 'T2' });
    expect(run(text, ev, [identity]).ok).toBe(true);
    const unlisted = run(text, ev);
    expect(unlisted.ok).toBe(false);
    expect(unlisted.errors.join('\n')).toContain('compatibility intake requires frozen cutover membership');
  });

  it('uses immutable high-watermark rather than advisory prior for hidden downsteps', () => {
    const r01 = draft('T1', 'T1');
    const r02 = draft('T3', 'T1');
    const current = draft('T2', 'T1');
    const result = run(current, evidence([
      { revision: 'r01', text: r01, tier: 'T1', receipt: receipt('r01', 'T1') },
      { revision: 'r02', text: r02, tier: 'T3', receipt: receipt('r02', 'T3') },
      { revision: 'r03', text: current, tier: 'T2', receipt: receipt('r03', 'T2') },
    ], { priorTier: 'T1' }));
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('observed downstep requires demotion-from and demotion-event');
  });

  it('accepts one adjacent final-lens demotion only after current-candidate revalidation', () => {
    const { currentText, transitionEvidence } = validDemotionEvidence();
    expect(run(currentText, transitionEvidence).ok).toBe(true);

    const withoutRevalidation = { ...transitionEvidence, revalidations: [] };
    const red = run(currentText, withoutRevalidation);
    expect(red.ok).toBe(false);
    expect(red.errors.join('\n')).toContain('current candidate requires exactly one matching final-lens revalidation');
  });

  it('allows same-event same-tier revalidation without consuming another demotion', () => {
    const { currentText, transitionEvidence } = validDemotionEvidence('r03');
    expect(run(currentText, transitionEvidence).ok).toBe(true);
  });

  it('rejects a multi-step downshift and a later downstep after up-escalation', () => {
    const source = draft('T3', 'T3');
    const t1 = draft('T1', 'T3', { demotionFrom: 'T3', demotionEvent: 'demotion-1' });
    const multi = evidence([
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: t1, tier: 'T1', receipt: receipt('r02', 'T1') },
    ], {
      events: [{ record: event({ afterTier: 'T1' }), captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens' }],
      revalidations: [{ record: revalidation('r02', { afterTier: 'T1' }), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens' }],
    });
    expect(run(t1, multi).errors.join('\n')).toContain('only one adjacent tier downstep is allowed');

    const demoted = draft('T2', 'T3', { demotionFrom: 'T3', demotionEvent: 'demotion-1' });
    const raised = draft('T3', 'T3', { demotionFrom: 'T3', demotionEvent: 'demotion-1' });
    const reused = evidence([
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: demoted, tier: 'T2', receipt: receipt('r02', 'T2') },
      { revision: 'r03', text: raised, tier: 'T3', receipt: receipt('r03', 'T3') },
      { revision: 'r04', text: demoted, tier: 'T2', receipt: receipt('r04', 'T2') },
    ], {
      currentRevision: 'r04',
      events: [{ record: event(), captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens' }],
      revalidations: [{ record: revalidation('r04'), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens' }],
    });
    const result = run(demoted, reused);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('event source/candidate transition binding mismatch');
  });

  it('rejects conflicting second events', () => {
    const { currentText, transitionEvidence } = validDemotionEvidence();
    transitionEvidence.events.push({
      record: event({ eventId: 'demotion-2' }),
      captureName: 'pass-03-architectural-lens.capture.txt',
      captureText: 'architect final lens',
    });
    const result = run(currentText, transitionEvidence);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('conflicting/second demotion event');
  });

  it('requires exact source driver disposition', () => {
    const { currentText, transitionEvidence } = validDemotionEvidence();
    transitionEvidence.events[0].record.drivers = [{
      kind: 'rubric',
      id: 'failure-type:local-behavior',
      rationale: 'Wrong substitute.',
    }];
    const result = run(currentText, transitionEvidence);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('exactly match source trigger set');
  });

  it('fails stale revalidation and active or stale L4 evidence', () => {
    const { currentText, transitionEvidence } = validDemotionEvidence();
    transitionEvidence.revalidations[0].record.candidateRevision = 'r01';
    expect(run(currentText, transitionEvidence).errors.join('\n')).toContain('current candidate requires exactly one matching final-lens revalidation');

    const active = validDemotionEvidence();
    active.transitionEvidence.revisions[1].receipt!.l4Status = 'active';
    active.transitionEvidence.revalidations[0].record.l4Status = 'active';
    const activeResult = run(active.currentText, active.transitionEvidence);
    expect(activeResult.ok).toBe(false);
    expect(activeResult.errors.join('\n')).toContain('below-T3 candidate requires current clear L4 evidence');
    expect(activeResult.errors.join('\n')).toContain('revalidation L4 evidence must be clear');
  });

  it('never lets demotion evidence suppress a live marker', () => {
    const source = draft('T3', 'T3');
    const current = draft('T2', 'T3', {
      demotionFrom: 'T3',
      demotionEvent: 'demotion-1',
      body: 'This change modifies required CI behavior.',
    });
    const transitionEvidence = evidence([
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: current, tier: 'T2', receipt: receipt('r02', 'T2', { markerRows: ['ci-review-gating'] }) },
    ], {
      events: [{ record: event(), captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens' }],
      revalidations: [{ record: revalidation('r02'), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens' }],
    });
    const result = run(current, transitionEvidence);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('red-flag marker hit (ci-review-gating) with tier T2 below T3');
  });

  it('distinguishes context-only quoted subject names from actual canonical marker predicates', () => {
    const quoted = draft('T2', 'T2', { body: 'Quoted example: "required CI".' });
    const quotedEvidence = evidence([
      { revision: 'r01', text: quoted, tier: 'T2', receipt: receipt('r01', 'T2') },
    ], { priorTier: 'T2' });
    expect(run(quoted, quotedEvidence).screen.hits).toEqual([]);

    const structural = draft('T3', 'T3', {
      body: 'This task introduces a new contract >= 2 future issues will depend on.',
    });
    const structuralResult = checkTierGateGuard(structural, { repoRoot: process.cwd() });
    expect(structuralResult.screen.hits).toContain('shared-contract-dependency');
  });

  it('supports dormant compatibility demotion only with frozen membership and historical final-lens evidence', () => {
    const source = draft('T3', 'T3');
    const after = draft('T2', 'T3', { demotionFrom: 'T3', demotionEvent: 'demotion-1' });
    const current = after;
    const compatibilityEvent = event({
      kind: 'compatibility',
      historicalAfterRevision: 'r02',
      historicalLensCapture: 'pass-00-architectural-lens.capture.txt',
    });
    const transitionEvidence = evidence([
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: after, tier: 'T2', receipt: receipt('r02', 'T2') },
      { revision: 'r03', text: current, tier: 'T2', receipt: receipt('r03', 'T2') },
    ], {
      currentRevision: 'r03',
      intakeKind: 'compatibility',
      events: [{ record: compatibilityEvent, captureName: 'pass-03-architectural-lens.capture.txt', captureText: 'architect final lens import' }],
      revalidations: [{ record: revalidation('r03'), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens revalidation' }],
      captures: [{
        captureName: 'pass-00-architectural-lens.capture.txt',
        captureText: 'Architect final lens sanctioned transition r01 to r02.',
      }],
    });
    expect(run(current, transitionEvidence, [identity], [identity]).ok).toBe(true);
    expect(run(current, transitionEvidence).errors.join('\n')).toContain('compatibility intake requires frozen cutover membership');
    expect(run(current, transitionEvidence, [identity]).errors.join('\n')).toContain(
      'compatibility event is absent from frozen historical-demotion census',
    );

    transitionEvidence.captures = [];
    expect(run(current, transitionEvidence, [identity], [identity]).errors.join('\n')).toContain('historical final-lens capture is missing');
  });

  it('freezes production compatibility eligibility empty at cutover', () => {
    expect(Object.isFrozen(PRE_973_CUTOVER_WORKDIR_IDENTITIES)).toBe(true);
    expect(PRE_973_CUTOVER_WORKDIR_IDENTITIES).toEqual([]);
    expect(Object.isFrozen(PRE_973_HISTORICAL_DEMOTIONS)).toBe(true);
    expect(PRE_973_HISTORICAL_DEMOTIONS).toEqual([]);
  });
});
