import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRE_973_CUTOVER_WORKDIR_IDENTITIES,
  PRE_973_HISTORICAL_DEMOTIONS,
  TIER_PROVENANCE_PRODUCER_ALLOWLIST,
  checkTierGateGuard,
  parseComplexityTierFence,
  parseDecisionReceipt,
  parseIntakeRecord,
  type TierDecisionReceiptRecord,
  type TierDemotionEventRecord,
  type TierDemotionRevalidationRecord,
  type TierTransitionEvidence,
} from './lib/tier-gate-core.ts';

type Tier = 'T1' | 'T2' | 'T3';
const identity = '973-fixture';

function draft(
  tier: Tier,
  prior: Tier,
  opts: { from?: Tier; eventId?: string; body?: string } = {},
): string {
  const demotion = opts.from && opts.eventId
    ? `\ndemotion-from: ${opts.from}\ndemotion-event: ${opts.eventId}`
    : '';
  return `# Fixture\n\n## Goal\n${opts.body ?? 'Describe one local behavior.'}\n\n\`\`\`behavior-kind\nrecord-only\n\`\`\`\n\n\`\`\`complexity-tier\ntier: ${tier}\nadvisory-prior: ${prior}${demotion}\n\`\`\`\n\n\`\`\`denylist\nvendor/**\npackages/core/**\n\`\`\`\n\n\`\`\`allowed-roots\ndocs/example.md\n\`\`\`\n\n## Acceptance criteria\n1. Fixture holds.\n\n## Verification\nRun focused tests.\n\n\`\`\`contract-evidence\nnone\n\`\`\`\n`;
}

function receipt(
  revision: string,
  tier: Tier,
  opts: Partial<Pick<TierDecisionReceiptRecord, 'markerRows' | 'rubricClasses' | 'l4Status' | 'producer'>> = {},
): TierDecisionReceiptRecord {
  return {
    schema: 'tier-gate-decision/v1',
    producer: opts.producer ?? 'cursor-flow-manager',
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
    drivers: [{
      kind: 'rubric',
      id: 'failure-type:subsystem-or-system-guarantee',
      rationale: 'The current change no longer changes a subsystem guarantee.',
    }],
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
  revisions: TierTransitionEvidence['revisions'],
  opts: Partial<Omit<TierTransitionEvidence, 'taskIdentity' | 'revisions'>> & {
    priorTier?: Tier;
    intakeKind?: 'fresh' | 'compatibility';
    firstRevision?: string;
  } = {},
): TierTransitionEvidence {
  const currentRevision = opts.currentRevision ?? revisions.at(-1)?.revision ?? '';
  return {
    taskIdentity: identity,
    currentRevision,
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

function validDemotion(currentRevision = 'r02') {
  const source = draft('T3', 'T3');
  const current = draft('T2', 'T3', { from: 'T3', eventId: 'demotion-1' });
  const revisions: TierTransitionEvidence['revisions'] = [
    { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
    { revision: 'r02', text: current, tier: 'T2', receipt: receipt('r02', 'T2') },
  ];
  if (currentRevision === 'r03') {
    revisions.push({ revision: 'r03', text: current, tier: 'T2', receipt: receipt('r03', 'T2') });
  }
  return {
    current,
    evidence: evidence(revisions, {
      currentRevision,
      events: [{ record: event(), captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens' }],
      revalidations: [{ record: revalidation(currentRevision), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens revalidation' }],
    }),
  };
}

describe('Issue #1093 tier provenance producer allowlist', () => {
  it('exposes a frozen exact producer allowlist with cursor and opencode identifiers', () => {
    expect(Object.isFrozen(TIER_PROVENANCE_PRODUCER_ALLOWLIST)).toBe(true);
    expect(TIER_PROVENANCE_PRODUCER_ALLOWLIST).toEqual([
      'cursor-flow-manager',
      'opencode-flow-manager',
    ]);
  });

  it('preserves exact producer through parseIntakeRecord and parseDecisionReceipt', () => {
    for (const producer of ['cursor-flow-manager', 'opencode-flow-manager'] as const) {
      expect(parseIntakeRecord({
        schema: 'tier-intake/v1',
        producer,
        taskIdentity: identity,
        kind: 'fresh',
        priorTier: 'T3',
        firstRevision: 'r01',
      })?.producer).toBe(producer);

      expect(parseDecisionReceipt({
        schema: 'tier-gate-decision/v1',
        producer,
        revision: 'r01',
        tier: 'T3',
        rubricClasses: ['failure-type:subsystem-or-system-guarantee'],
        l4Status: 'clear',
      })?.producer).toBe(producer);
    }
  });

  it('rejects unknown, missing, and non-string producers for intake and decision', () => {
    const baseIntake = {
      schema: 'tier-intake/v1',
      taskIdentity: identity,
      kind: 'fresh',
      priorTier: 'T3',
      firstRevision: 'r01',
    };
    expect(parseIntakeRecord({ ...baseIntake, producer: 'unsanctioned-flow-manager' })).toBeNull();
    expect(parseIntakeRecord({ ...baseIntake })).toBeNull();
    expect(parseIntakeRecord({ ...baseIntake, producer: 42 })).toBeNull();

    const baseDecision = {
      schema: 'tier-gate-decision/v1',
      revision: 'r01',
      tier: 'T3',
      rubricClasses: ['failure-type:subsystem-or-system-guarantee'],
      l4Status: 'clear',
    };
    expect(parseDecisionReceipt({ ...baseDecision, producer: 'unsanctioned-flow-manager' })).toBeNull();
    expect(parseDecisionReceipt({ ...baseDecision })).toBeNull();
    expect(parseDecisionReceipt({ ...baseDecision, producer: null })).toBeNull();
  });

  it('fail-closed at guard level for unknown, missing, and non-string producers', () => {
    const text = draft('T2', 'T2');
    const stem = '1093-guard-negative-fixture';
    const root = mkdtempSync(join(tmpdir(), 'opk-1093-guard-'));
    try {
      const anchorDir = join(root, 'docs', 'issues_drafts');
      const reviewDir = join(anchorDir, '.review', stem);
      const revisionDir = join(root, 'r01');
      mkdirSync(reviewDir, { recursive: true });
      mkdirSync(revisionDir, { recursive: true });
      const anchor = join(anchorDir, `${stem}.md`);
      writeFileSync(anchor, text);
      writeFileSync(join(revisionDir, `${stem}.md`), text);
      writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(receipt('r01', 'T2')));

      const intakeCases: Array<[string, Record<string, unknown>, string]> = [
        ['unknown intake producer', {
          schema: 'tier-intake/v1',
          producer: 'unsanctioned-flow-manager',
          taskIdentity: stem,
          kind: 'fresh',
          priorTier: 'T2',
          firstRevision: 'r01',
        }, 'malformed flow-manager intake evidence'],
        ['missing intake producer', {
          schema: 'tier-intake/v1',
          taskIdentity: stem,
          kind: 'fresh',
          priorTier: 'T2',
          firstRevision: 'r01',
        }, 'malformed flow-manager intake evidence'],
        ['non-string intake producer', {
          schema: 'tier-intake/v1',
          producer: 42,
          taskIdentity: stem,
          kind: 'fresh',
          priorTier: 'T2',
          firstRevision: 'r01',
        }, 'malformed flow-manager intake evidence'],
      ];
      for (const [label, intakeRecord, expected] of intakeCases) {
        writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify(intakeRecord));
        const result = checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath: anchor });
        expect(result.ok, label).toBe(false);
        expect(result.errors.join('\n'), label).toContain(expected);
      }

      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
        schema: 'tier-intake/v1',
        producer: 'cursor-flow-manager',
        taskIdentity: stem,
        kind: 'fresh',
        priorTier: 'T2',
        firstRevision: 'r01',
      }));

      const receiptCases: Array<[string, Record<string, unknown>]> = [
        ['unknown decision producer', {
          schema: 'tier-gate-decision/v1',
          producer: 'unsanctioned-flow-manager',
          revision: 'r01',
          tier: 'T2',
          rubricClasses: ['failure-type:local-behavior'],
          l4Status: 'clear',
        }],
        ['missing decision producer', {
          schema: 'tier-gate-decision/v1',
          revision: 'r01',
          tier: 'T2',
          rubricClasses: ['failure-type:local-behavior'],
          l4Status: 'clear',
        }],
        ['non-string decision producer', {
          schema: 'tier-gate-decision/v1',
          producer: null,
          revision: 'r01',
          tier: 'T2',
          rubricClasses: ['failure-type:local-behavior'],
          l4Status: 'clear',
        }],
      ];
      for (const [label, receiptRecord] of receiptCases) {
        writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(receiptRecord));
        const result = checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath: anchor });
        expect(result.ok, label).toBe(false);
        expect(result.errors.join('\n'), label).toContain('missing or malformed tier-gate receipt for r01');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts opencode-flow-manager intake and decision through tier gate', () => {
    const text = draft('T2', 'T2');
    const revisions = [{
      revision: 'r01',
      text,
      tier: 'T2' as const,
      receipt: receipt('r01', 'T2', { producer: 'opencode-flow-manager' }),
    }];
    const transitionEvidence = evidence(revisions, {
      intake: {
        schema: 'tier-intake/v1',
        producer: 'opencode-flow-manager',
        taskIdentity: identity,
        kind: 'fresh',
        priorTier: 'T2',
        firstRevision: 'r01',
      },
    });
    expect(run(text, transitionEvidence).ok).toBe(true);
  });

  it('does not admit unknown producers via environment override', () => {
    const envVars = [
      'TIER_PROVENANCE_PRODUCER',
      'TIER_PRODUCER_ALLOWLIST',
      'OPENCODE_FLOW_MANAGER',
      'PRODUCER_ALLOWLIST',
    ];
    for (const envVar of envVars) {
      const previous = process.env[envVar];
      process.env[envVar] = 'unsanctioned-flow-manager';
      try {
        expect(parseIntakeRecord({
          schema: 'tier-intake/v1',
          producer: 'unsanctioned-flow-manager',
          taskIdentity: identity,
          kind: 'fresh',
          priorTier: 'T2',
          firstRevision: 'r01',
        })).toBeNull();
      } finally {
        if (previous === undefined) delete process.env[envVar];
        else process.env[envVar] = previous;
      }
    }
  });

  it('accepts prewritten opencode provenance bytes without rewriting records', () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-1093-'));
    try {
      const stem = '1093-retroactive-fixture';
      const anchorDir = join(root, 'docs', 'issues_drafts');
      const reviewDir = join(anchorDir, '.review', stem);
      const revisionDir = join(root, 'r01');
      mkdirSync(reviewDir, { recursive: true });
      mkdirSync(revisionDir, { recursive: true });
      const anchor = join(anchorDir, `${stem}.md`);
      const text = draft('T2', 'T2');
      writeFileSync(anchor, text);
      writeFileSync(join(revisionDir, `${stem}.md`), text);
      const intakePath = join(reviewDir, 'tier-intake.json');
      const receiptPath = join(revisionDir, 'tier-gate-receipt.json');
      writeFileSync(intakePath, JSON.stringify({
        schema: 'tier-intake/v1',
        producer: 'opencode-flow-manager',
        taskIdentity: stem,
        kind: 'fresh',
        priorTier: 'T2',
        firstRevision: 'r01',
      }));
      writeFileSync(receiptPath, JSON.stringify({
        schema: 'tier-gate-decision/v1',
        producer: 'opencode-flow-manager',
        revision: 'r01',
        tier: 'T2',
        rubricClasses: ['failure-type:local-behavior'],
        l4Status: 'clear',
      }));
      const intakeHashBefore = createHash('sha256').update(readFileSync(intakePath)).digest('hex');
      const receiptHashBefore = createHash('sha256').update(readFileSync(receiptPath)).digest('hex');

      const result = checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath: anchor });
      expect(result.errors.join('\n')).not.toContain('malformed flow-manager intake evidence');

      expect(createHash('sha256').update(readFileSync(intakePath)).digest('hex')).toBe(intakeHashBefore);
      expect(createHash('sha256').update(readFileSync(receiptPath)).digest('hex')).toBe(receiptHashBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Issue #973 tier provenance', () => {
  it('requires demotion fence fields as a pair', () => {
    expect(parseComplexityTierFence(draft('T2', 'T3', { from: 'T3', eventId: 'demotion-1' })))
      .toMatchObject({ demotionFrom: 'T3', demotionEvent: 'demotion-1' });
    expect(parseComplexityTierFence('```complexity-tier\ntier: T2\ndemotion-from: T3\n```'))
      .toMatchObject({ kind: 'unparseable' });
  });

  it('keeps a fresh intake floor authoritative across later revisions', () => {
    const text = draft('T2', 'T2');
    for (const revisions of [
      [{ revision: 'r01', text, tier: 'T2' as const, receipt: receipt('r01', 'T2') }],
      [
        { revision: 'r01', text, tier: 'T2' as const, receipt: receipt('r01', 'T2') },
        { revision: 'r02', text, tier: 'T2' as const, receipt: receipt('r02', 'T2') },
      ],
    ]) {
      const result = run(text, evidence(revisions, { currentRevision: revisions.at(-1)!.revision, priorTier: 'T3' }));
      expect(result.ok).toBe(false);
      expect(result.errors.join('\n')).toContain('first authoritative candidate cannot be below intake prior');
    }
  });

  it('fails closed on missing or malformed manager intake evidence', () => {
    const text = draft('T2', 'T2');
    expect(run(text, evidence([{ revision: 'r01', text, tier: 'T2', receipt: receipt('r01', 'T2') }], { intake: null })).errors.join('\n'))
      .toContain('missing flow-manager intake evidence');

    const root = mkdtempSync(join(tmpdir(), 'opk-973-'));
    try {
      const stem = '973-loader-fixture';
      const anchorDir = join(root, 'docs', 'issues_drafts');
      const reviewDir = join(anchorDir, '.review', stem);
      const revisionDir = join(root, 'r01');
      mkdirSync(reviewDir, { recursive: true });
      mkdirSync(revisionDir, { recursive: true });
      const anchor = join(anchorDir, `${stem}.md`);
      writeFileSync(anchor, text);
      writeFileSync(join(revisionDir, `${stem}.md`), text);
      writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(receipt('r01', 'T2')));
      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({ schema: 'tier-intake/v1', producer: 'browser-gpt', taskIdentity: stem, kind: 'fresh', priorTier: 'T2', firstRevision: 'r01' }));
      expect(checkTierGateGuard(text, { repoRoot: process.cwd(), draftPath: anchor }).errors.join('\n'))
        .toContain('malformed flow-manager intake evidence');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('freezes production compatibility eligibility empty and rejects unlisted lookalikes', () => {
    expect(Object.isFrozen(PRE_973_CUTOVER_WORKDIR_IDENTITIES)).toBe(true);
    expect(PRE_973_CUTOVER_WORKDIR_IDENTITIES).toEqual([]);
    expect(Object.isFrozen(PRE_973_HISTORICAL_DEMOTIONS)).toBe(true);
    expect(PRE_973_HISTORICAL_DEMOTIONS).toEqual([]);
    const text = draft('T2', 'T2');
    const compat = evidence([{ revision: 'r01', text, tier: 'T2', receipt: receipt('r01', 'T2') }], { intakeKind: 'compatibility', priorTier: 'T2' });
    expect(run(text, compat).errors.join('\n')).toContain('compatibility intake requires frozen cutover membership');
    expect(run(text, compat, [identity]).ok).toBe(true);
  });

  it('uses immutable high-watermark rather than advisory-prior for hidden downsteps', () => {
    const r01 = draft('T1', 'T1');
    const r02 = draft('T3', 'T1');
    const current = draft('T2', 'T1');
    const result = run(current, evidence([
      { revision: 'r01', text: r01, tier: 'T1', receipt: receipt('r01', 'T1') },
      { revision: 'r02', text: r02, tier: 'T3', receipt: receipt('r02', 'T3') },
      { revision: 'r03', text: current, tier: 'T2', receipt: receipt('r03', 'T2') },
    ], { currentRevision: 'r03', priorTier: 'T1' }));
    expect(result.errors.join('\n')).toContain('observed downstep requires demotion-from and demotion-event');
  });

  it('requires a newer current-candidate revalidation after the demotion event', () => {
    const valid = validDemotion();
    expect(run(valid.current, valid.evidence).ok).toBe(true);
    expect(run(valid.current, { ...valid.evidence, revalidations: [] }).errors.join('\n'))
      .toContain('current candidate requires exactly one matching final-lens revalidation');
    valid.evidence.events[0].captureName = 'pass-02-architectural-lens.capture.txt';
    valid.evidence.revalidations[0].captureName = 'pass-01-architectural-lens.capture.txt';
    expect(run(valid.current, valid.evidence).errors.join('\n'))
      .toContain('current-candidate revalidation must be newer than demotion event');
  });

  it('allows same-event same-tier revalidation but rejects multi-step and second events', () => {
    const sameTier = validDemotion('r03');
    expect(run(sameTier.current, sameTier.evidence).ok).toBe(true);
    const source = draft('T3', 'T3');
    const t1 = draft('T1', 'T3', { from: 'T3', eventId: 'demotion-1' });
    const multi = evidence([
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: t1, tier: 'T1', receipt: receipt('r02', 'T1') },
    ], {
      events: [{ record: event({ afterTier: 'T1' }), captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens' }],
      revalidations: [{ record: revalidation('r02', { afterTier: 'T1' }), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens' }],
    });
    expect(run(t1, multi).errors.join('\n')).toContain('only one adjacent tier downstep is allowed');
    const second = validDemotion();
    second.evidence.events.push({ record: event({ eventId: 'demotion-2' }), captureName: 'pass-03-architectural-lens.capture.txt', captureText: 'architect final lens' });
    expect(run(second.current, second.evidence).errors.join('\n')).toContain('conflicting/second demotion event');
  });

  it('rejects reuse after later up-escalation', () => {
    const source = draft('T3', 'T3');
    const demoted = draft('T2', 'T3', { from: 'T3', eventId: 'demotion-1' });
    const raised = draft('T3', 'T3', { from: 'T3', eventId: 'demotion-1' });
    const result = run(demoted, evidence([
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: demoted, tier: 'T2', receipt: receipt('r02', 'T2') },
      { revision: 'r03', text: raised, tier: 'T3', receipt: receipt('r03', 'T3') },
      { revision: 'r04', text: demoted, tier: 'T2', receipt: receipt('r04', 'T2') },
    ], { currentRevision: 'r04', events: [{ record: event(), captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens' }], revalidations: [{ record: revalidation('r04'), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens' }] }));
    expect(result.ok).toBe(false);
  });

  it('requires exact source rubric drivers and clear current L4', () => {
    const drivers = validDemotion();
    drivers.evidence.events[0].record.drivers = [{ kind: 'rubric', id: 'failure-type:local-behavior', rationale: 'Wrong substitute.' }];
    expect(run(drivers.current, drivers.evidence).errors.join('\n')).toContain('exactly match source trigger set');

    const l4 = validDemotion();
    l4.evidence.revisions[1].receipt!.l4Status = 'active';
    l4.evidence.revalidations[0].record.l4Status = 'active';
    const l4Errors = run(l4.current, l4.evidence).errors.join('\n');
    expect(l4Errors).toContain('below-T3 candidate requires current clear L4 evidence');
    expect(l4Errors).toContain('revalidation L4 evidence must be clear');
  });

  it('keeps compatibility demotion dormant unless fixture membership and historical evidence are explicit', () => {
    const source = draft('T3', 'T3');
    const current = draft('T2', 'T3', { from: 'T3', eventId: 'demotion-1' });
    const compatEvent = event({ kind: 'compatibility', historicalAfterRevision: 'r02', historicalLensCapture: 'pass-00-architectural-lens.capture.txt' });
    const compat = evidence([
      { revision: 'r01', text: source, tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: current, tier: 'T2', receipt: receipt('r02', 'T2') },
      { revision: 'r03', text: current, tier: 'T2', receipt: receipt('r03', 'T2') },
    ], {
      currentRevision: 'r03', intakeKind: 'compatibility',
      events: [{ record: compatEvent, captureName: 'pass-01-architectural-lens.capture.txt', captureText: 'architect final lens import' }],
      revalidations: [{ record: revalidation('r03'), captureName: 'pass-02-architectural-lens.capture.txt', captureText: 'architect final lens revalidation' }],
      captures: [{ captureName: 'pass-00-architectural-lens.capture.txt', captureText: 'Architect final lens sanctioned transition r01 to r02.' }],
    });
    expect(run(current, compat, [identity], [identity]).ok).toBe(true);
    expect(run(current, compat).errors.join('\n')).toContain('compatibility intake requires frozen cutover membership');
    compat.captures = [];
    expect(run(current, compat, [identity], [identity]).errors.join('\n')).toContain('historical final-lens capture is missing');
  });
});

describe('Issue #1029 lexical marker retirement', () => {
  const markerSuffix = '\n\nBackground mentions concurrency, required CI, durable state, provenance, crash/recovery, and liveness.';

  function skipLineDraft(): string {
    return `# Fixture\n\n## Goal\nOperator config tweak.\n\n\`\`\`behavior-kind\nrecord-only\n\`\`\`\n\n\`\`\`complexity-tier\nskip-line: true\n\`\`\`\n\n\`\`\`denylist\nvendor/**\npackages/core/**\n\`\`\`\n\n\`\`\`allowed-roots\ndocs/example.md\n\`\`\`\n\n## Acceptance criteria\n1. Fixture holds.\n\n## Verification\nRun focused tests.\n\n\`\`\`contract-evidence\nnone\n\`\`\`\n`;
  }

  it('preserves lower-tier and skip-line gate outcomes when former marker vocabulary is injected', () => {
    const cases = [
      { label: 'T1', text: draft('T1', 'T1') },
      { label: 'T2', text: draft('T2', 'T2') },
      { label: 'no-tier', text: skipLineDraft() },
    ];
    for (const testCase of cases) {
      const baseline = checkTierGateGuard(testCase.text, { repoRoot: process.cwd() });
      const injected = checkTierGateGuard(`${testCase.text}${markerSuffix}`, { repoRoot: process.cwd() });
      expect(injected.ok, testCase.label).toBe(baseline.ok);
      expect(injected.errors, testCase.label).toEqual(baseline.errors);
      expect(injected.stages, testCase.label).toEqual(baseline.stages);
      expect(injected.receipt, testCase.label).toEqual(baseline.receipt);
    }
  });

  it('ignores legacy marker drivers when validating demotion source-driver equality', () => {
    const valid = validDemotion();
    valid.evidence.events[0].record.drivers = [
      { kind: 'marker', id: 'ci-review-gating', rationale: 'Legacy marker row no longer authoritative.' },
      { kind: 'rubric', id: 'failure-type:subsystem-or-system-guarantee', rationale: 'Still applies.' },
    ];
    expect(run(valid.current, valid.evidence).ok).toBe(true);
  });
});
