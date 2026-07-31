import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PRE_1142_COMPLETED_DEMOTION_IDENTITIES,
  checkTierGateGuard,
  inspectRetiredDemotionCapture,
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
import { runCli } from './tier-gate-guard.ts';

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
    retiredDemotionFences: options.retiredDemotionFences,
  };
}

function run(text: string, transitionEvidence: TierTransitionEvidence, legacy: readonly string[] = []) {
  return checkTierGateGuard(text, {
    repoRoot: process.cwd(),
    transitionEvidence,
    completedLegacyDemotionIdentities: legacy,
  });
}

function captureHeader(revision: string): string {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    expect(runCli(['node', 'tier-gate-guard.ts', '--capture-revision', revision])).toBe(0);
    expect(stderr).toEqual([]);
    return stdout.join('');
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

function retiredCaptureOptions(captureText: string, captureName = 'pass-01-architectural.capture.txt') {
  const inspection = inspectRetiredDemotionCapture(captureText);
  return {
    events: inspection.events.map((record) => ({ record, captureName, captureText })),
    revalidations: inspection.revalidations.map((record) => ({ record, captureName, captureText })),
    retiredDemotionFences: inspection.fences,
    captures: [{ captureName, captureText }],
  };
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

  it('rejects legacy clear on every fresh below-T3 receipt while preserving parser compatibility', () => {
    const first = draft('T2', 'T2');
    const legacyFirst = parseDecisionReceipt({
      schema: 'tier-gate-decision/v1', producer: 'cursor-flow-manager', revision: 'r01', tier: 'T2',
      rubricClasses: ['failure-type:local-behavior'], l4Status: 'clear',
    });
    const firstErrors = run(first, evidence([
      { revision: 'r01', text: first, tier: 'T2', receipt: legacyFirst },
    ], { priorTier: 'T2' })).errors.join('\n');
    expect(firstErrors).toContain('fresh below-T3 receipt must emit l4Status not-applicable');

    const second = draft('T2', 'T2');
    const legacySecond = parseDecisionReceipt({
      schema: 'tier-gate-decision/v1', producer: 'cursor-flow-manager', revision: 'r02', tier: 'T2',
      rubricClasses: ['failure-type:local-behavior'], l4Status: 'clear',
    });
    const secondErrors = run(second, evidence([
      { revision: 'r01', text: first, tier: 'T2', receipt: receipt('r01', 'T2') },
      { revision: 'r02', text: second, tier: 'T2', receipt: legacySecond },
    ], { priorTier: 'T2' })).errors.join('\n');
    expect(secondErrors).toContain('fresh below-T3 receipt must emit l4Status not-applicable');
  });

  it('keeps T1 and T2 on the same one-terminal-architectural review pipeline', () => {
    expect(selectAuthoringReviewStages({ tier: 'T1', skipLine: false }).review).toEqual(['architectural']);
    expect(selectAuthoringReviewStages({ tier: 'T2', skipLine: false }).review).toEqual(['architectural']);
    expect(selectAuthoringReviewStages({ tier: 'T1', skipLine: false, explicitAdversarialWrapper: true })).toMatchObject({
      effectiveTier: 'T2',
      review: ['architectural'],
      wrapperFloorApplied: true,
    });
    expect(selectAuthoringReviewStages({ tier: 'T2', skipLine: false, explicitAdversarialWrapper: true }).review).toEqual(['architectural']);
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

  it('rejects correction fields on the first authoritative receipt', () => {
    const current = draft('T2', 'T2');
    const transitionEvidence = evidence([{
      revision: 'r01',
      text: current,
      tier: 'T2',
      receipt: receipt('r01', 'T2', { correctedFrom: 'T3', reason: 'false first-revision correction' }),
    }], { priorTier: 'T2' });
    expect(run(current, transitionEvidence).errors.join('\n')).toContain('first authoritative receipt');
  });

  it('rejects correction after a selected canonical reviewer capture', () => {
    const fixture = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-competitive.capture.txt', captureText: 'issue_revision: r01\nNO_FINDINGS' }],
    });
    expect(run(fixture.current, fixture.transitionEvidence).errors.join('\n')).toContain('already closed');
  });

  it('produces a deterministic capture header and accepts it after the corrected receipt', () => {
    const producedHeader = captureHeader('R02');
    expect(producedHeader).toBe('issue_revision: r02\n');
    const fixture = correction('T3', 'T2', {
      captures: [{ captureName: 'pass-01-architectural.capture.txt', captureText: `${producedHeader}NO_FINDINGS` }],
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

  it('fails closed when the same Issue is replayed through a second workdir', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'tier-issue-history-'));
    const previousHome = process.env.HOME;
    const stateRoot = join(tempHome, '.local', 'state', 'create-issue-draft');
    const firstWorkdir = join(stateRoot, '1142');
    const replayWorkdir = join(stateRoot, '1142-replay');

    const writeHistory = (workdir: string, stem: string, revisions: Array<{ revision: string; text: string; receipt: TierDecisionReceiptRecord }>, reviewIdentity: string): string => {
      const issueDrafts = join(workdir, 'docs', 'issues_drafts');
      const reviewDir = join(issueDrafts, '.review', reviewIdentity);
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({
        schema: 'tier-intake/v1',
        producer: 'cursor-flow-manager',
        taskIdentity: reviewIdentity,
        kind: 'fresh',
        priorTier: revisions[0]?.receipt.tier,
        firstRevision: revisions[0]?.revision,
      }));
      for (const revision of revisions) {
        const revisionDir = join(workdir, revision.revision);
        mkdirSync(revisionDir, { recursive: true });
        writeFileSync(join(revisionDir, `${stem}.md`), revision.text);
        writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(revision.receipt));
      }
      const anchor = join(issueDrafts, `${stem}.md`);
      mkdirSync(issueDrafts, { recursive: true });
      writeFileSync(anchor, revisions.at(-1)?.text ?? '');
      return anchor;
    };

    try {
      process.env.HOME = tempHome;
      const first = draft('T3', 'T3', { behavior: 'action-producing' });
      writeHistory(firstWorkdir, '1142-original', [
        { revision: 'r01', text: first, receipt: receipt('r01', 'T3') },
      ], '1142');
      const issueReviewDir = join(stateRoot, '.review', '1142');
      mkdirSync(issueReviewDir, { recursive: true });
      writeFileSync(join(issueReviewDir, 'tier-intake.json'), JSON.stringify({ schema: 'tier-intake/v1', producer: 'cursor-flow-manager', taskIdentity: '1142', kind: 'fresh', priorTier: 'T3', firstRevision: 'r01' }));
      writeFileSync(join(issueReviewDir, 'pass-01-competitive.capture.txt'), 'issue_revision: r01\nNO_FINDINGS');

      const replayFirst = draft('T3', 'T3', { behavior: 'action-producing' });
      const replayCurrent = draft('T2', 'T3', { behavior: 'action-producing' });
      const replayAnchor = writeHistory(replayWorkdir, '1142-replay', [
        { revision: 'r01', text: replayFirst, receipt: receipt('r01', 'T3') },
        { revision: 'r02', text: replayCurrent, receipt: receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'replay attempt' }) },
      ], '1142-replay');

      const stderr: string[] = [];
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
      try {
        expect(runCli(['node', 'tier-gate-guard.ts', '--text-file', replayAnchor, '--draft-path', replayAnchor])).toBe(1);
        expect(stderr.join('')).toContain('canonical Issue-number workdir history');
      } finally {
        stderrSpy.mockRestore();
        stdoutSpy.mockRestore();
      }
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('retains capture history when the anchor slug changes inside the canonical Issue workdir', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'tier-slug-history-'));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = tempHome;
      const workdir = join(tempHome, '.local', 'state', 'create-issue-draft', '1142');
      const issueDrafts = join(workdir, 'docs', 'issues_drafts');
      const reviewDir = join(tempHome, '.local', 'state', 'create-issue-draft', '.review', '1142');
      mkdirSync(reviewDir, { recursive: true });
      writeFileSync(join(reviewDir, 'tier-intake.json'), JSON.stringify({ schema: 'tier-intake/v1', producer: 'cursor-flow-manager', taskIdentity: '1142', kind: 'fresh', priorTier: 'T3', firstRevision: 'r01' }));
      writeFileSync(join(reviewDir, 'pass-01-competitive.capture.txt'), 'issue_revision: r01\nNO_FINDINGS');

      const first = draft('T3', 'T3', { behavior: 'action-producing' });
      const current = draft('T2', 'T3', { behavior: 'action-producing' });
      for (const [revision, stem, text, decision] of [
        ['r01', '1142-old-slug', first, receipt('r01', 'T3')],
        ['r02', '1142-new-slug', current, receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'over-tiered' })],
      ] as const) {
        const revisionDir = join(workdir, revision);
        mkdirSync(revisionDir, { recursive: true });
        writeFileSync(join(revisionDir, `${stem}.md`), text);
        writeFileSync(join(revisionDir, 'tier-gate-receipt.json'), JSON.stringify(decision));
      }
      const anchor = join(issueDrafts, '1142-new-slug.md');
      mkdirSync(issueDrafts, { recursive: true });
      writeFileSync(anchor, current);
      const result = checkTierGateGuard(current, { repoRoot: process.cwd(), draftPath: anchor });
      expect(result.errors.join('\n')).toContain('already closed');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('rejects retired demotion fence fields for a fresh task', () => {
    const current = draft('T2', 'T3', { legacyFence: true });
    const transitionEvidence = evidence([
      { revision: 'r01', text: draft('T3', 'T3'), tier: 'T3', receipt: receipt('r01', 'T3') },
      { revision: 'r02', text: current, tier: 'T2', receipt: receipt('r02', 'T2', { correctedFrom: 'T3', reason: 'over-tiered' }) },
    ]);
    expect(run(current, transitionEvidence).errors.join('\n')).toContain('retired demotion fence fields');
  });

  it('rejects malformed and former fresh-shape retired demotion capture output', () => {
    const current = draft('T2', 'T2');
    const samples = [
      '```tier-demotion-event\n{not-json}\n```',
      '```tier-demotion-event\n{"schema":"tier-demotion-event/v1","eventId":"new-1","kind":"new","sourceRevision":"r01","beforeTier":"T3","afterTier":"T2"}\n```',
      '```tier-demotion-revalidation\n{broken-json}\n```',
    ];
    for (const captureText of samples) {
      const transitionEvidence = evidence([
        { revision: 'r01', text: current, tier: 'T2', receipt: receipt('r01', 'T2') },
      ], { priorTier: 'T2', ...retiredCaptureOptions(captureText) });
      expect(run(current, transitionEvidence).errors.join('\n')).toContain('retired demotion records');
    }
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

  it('rejects a valid compatibility chain with any appended malformed retired fence', () => {
    const validEvent = '```tier-demotion-event\n{"schema":"tier-demotion-event/v1","eventId":"old-1","kind":"compatibility","sourceRevision":"r01","beforeTier":"T3","afterTier":"T2"}\n```';
    const validRevalidation = '```tier-demotion-revalidation\n{"schema":"tier-demotion-revalidation/v1","eventId":"old-1","candidateRevision":"r02","beforeTier":"T3","afterTier":"T2"}\n```';
    for (const malformed of [
      '```tier-demotion-event\n{bad}\n```',
      '```tier-demotion-revalidation\n{bad}\n```',
    ]) {
      const fixture = legacyFixture();
      const captureText = `${validEvent}\n${validRevalidation}\n${malformed}`;
      const parsed = retiredCaptureOptions(captureText, 'pass-01-architectural-lens.capture.txt');
      fixture.transitionEvidence.events = parsed.events;
      fixture.transitionEvidence.revalidations = parsed.revalidations;
      fixture.transitionEvidence.retiredDemotionFences = parsed.retiredDemotionFences;
      fixture.transitionEvidence.captures = parsed.captures;
      expect(run(fixture.current, fixture.transitionEvidence, [legacyIdentity]).errors.join('\n')).toContain('no extra or malformed retired fences');
    }
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
