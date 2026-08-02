import { describe, expect, it } from 'vitest';
import {
  REVIEW_LANE_CLASSIFIER_POLICY_VERSION,
  REVIEW_LANE_ROUTING_POLICY_VERSION,
  buildReviewLaneRouting,
  classifyReviewLaneDeclaration,
  evaluateMaterialVerdictConflict,
  freezeConsistentReviewLaneBody,
  normalizeReviewLaneDeclaration,
  settleReviewLane,
  type ReviewLaneAuthorDeclaration,
  type ReviewLaneBodyRead,
} from './review-lane-routing.ts';

const declaration = (entries: ReviewLaneAuthorDeclaration['entries']): ReviewLaneAuthorDeclaration => ({
  schema: 'review-lane-change-set/v1',
  owner: 'issue-author',
  entries,
});

describe('review-lane declaration and blast-radius routing', () => {
  it('keeps each exact path independent and classifies one through six paths as low', () => {
    const result = normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'docs/tiering.md', behaviors: ['documentation-only', 'tier-lane-orthogonality'] },
      { kind: 'exact', path: 'docs/review-lanes.md', behaviors: ['documentation-only'] },
      { kind: 'exact', path: 'scripts/lib/tier-gate-core.ts', behaviors: ['tier-lane-orthogonality', 'routing-policy-epoch'] },
    ]));

    expect(result.status).toBe('usable');
    if (result.status !== 'usable') return;
    expect(result.entries).toHaveLength(3);
    expect(result.blastRadius).toBe('low');
    expect(result.entries.map((entry) => entry.path)).toEqual([
      'docs/review-lanes.md',
      'docs/tiering.md',
      'scripts/lib/tier-gate-core.ts',
    ]);
  });

  it('treats family entries and seven exact paths as high-or-uncertain and high', () => {
    const family = normalizeReviewLaneDeclaration(declaration([
      { kind: 'family', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
    ]));
    expect(family.status).toBe('usable');
    if (family.status === 'usable') expect(family.blastRadius).toBe('high-or-uncertain');

    const seven = normalizeReviewLaneDeclaration(declaration(Array.from({ length: 7 }, (_, index) => ({
      kind: 'exact' as const,
      path: `scripts/lib/review-lane-${index}.ts`,
      behaviors: ['pure-review-lane-selection'],
    }))));
    expect(seven.status).toBe('usable');
    if (seven.status === 'usable') expect(seven.blastRadius).toBe('high');
  });

  it('does not merge duplicate paths with different semantics', () => {
    const result = normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'docs/tiering.md', behaviors: ['documentation-only', 'tier-lane-orthogonality'] },
      { kind: 'exact', path: 'docs/tiering.md', behaviors: ['documentation-only'] },
    ]));

    expect(result).toMatchObject({
      status: 'author-revision-required',
      reason: 'declaration-contradictory',
    });
  });

  it('rejects denied and outside paths without repairing author input', () => {
    expect(normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'prompts/example.md', behaviors: ['documentation-only'] },
    ])).reason).toBe('declared-path-denied');
    expect(normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'src/new.ts', behaviors: ['pure-review-lane-selection'] },
    ])).reason).toBe('declared-path-outside-allowed-roots');
    expect(normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: '../scripts/new.ts', behaviors: ['pure-review-lane-selection'] },
    ])).reason).toBe('path-not-repository-relative');
  });
});

describe('review-lane classifier v1', () => {
  it('applies compound access-control matching before safe-family admission', () => {
    const paths = [
      'docs/declarations/access-control.ts',
      'docs/declarations/ACCESS-CONTROL.ts',
      '.claude/skills/create-issue-draft/Access-Control/index.ts',
      'scripts/lib/review-lane-foo/access-control.ts',
    ];
    for (const path of paths) {
      const result = classifyReviewLaneDeclaration(declaration([
        { kind: 'exact', path, behaviors: ['scope-declaration-only'] },
      ]));
      expect(result.policyStatus).toBe('available');
      expect(result.scopeClass).toBe('security-sensitive');
    }
  });

  it('uses destructive over security and conservative over safe', () => {
    const destructive = classifyReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'scripts/lib/review-lane-delete.ts', behaviors: ['pure-review-lane-selection'] },
    ]));
    expect(destructive.scopeClass).toBe('destructive');

    const conservative = classifyReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'scripts/lib/review-lane-unknown.ts', behaviors: ['mystery-behavior'] },
    ]));
    expect(conservative.scopeClass).toBe('conservative-invalid');
    expect(conservative.conservativeReasons).toContain('unknown-behavior-tag');
  });

  it('routes low safe, high safe, and conservative scopes to distinct immutable topologies', () => {
    const low = normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'docs/review-lanes.md', behaviors: ['documentation-only'] },
    ]));
    const high = normalizeReviewLaneDeclaration(declaration([
      ...Array.from({ length: 7 }, (_, index) => ({
        kind: 'exact' as const,
        path: `scripts/lib/review-lane-${index}.ts`,
        behaviors: ['pure-review-lane-selection'],
      })),
    ]));
    const lowClass = classifyReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'docs/review-lanes.md', behaviors: ['documentation-only'] },
    ]));
    const highClass = classifyReviewLaneDeclaration(declaration([
      ...Array.from({ length: 7 }, (_, index) => ({
        kind: 'exact' as const,
        path: `scripts/lib/review-lane-${index}.ts`,
        behaviors: ['pure-review-lane-selection'],
      })),
    ]));
    expect(low.status).toBe('usable');
    expect(high.status).toBe('usable');
    expect(buildReviewLaneRouting(low, lowClass, 'r1', 'attempt-1').topology).toBe('fixed/v1');
    expect(buildReviewLaneRouting(high, highClass, 'r1', 'attempt-2').topology).toBe('conditional-third/v1');
    expect(buildReviewLaneRouting(high, {
      ...highClass,
      scopeClass: 'conservative-invalid',
    }, 'r1', 'attempt-3').initiallyActivatedSlots).toEqual(['01', '02', '03']);
  });
});

describe('body identity and material verdicts', () => {
  it('freezes only after two consecutive equal revision/body pairs', () => {
    const reads: ReviewLaneBodyRead[] = [
      { sourceRevision: 'r1', body: 'first' },
      { sourceRevision: 'r2', body: 'second' },
      { sourceRevision: 'r2', body: 'second' },
    ];
    expect(freezeConsistentReviewLaneBody(reads)).toMatchObject({
      status: 'frozen',
      sourceRevision: 'r2',
    });
    expect(freezeConsistentReviewLaneBody(reads.slice(0, 2)).status).toBe('producer-unavailable');
  });

  it('only material verdict disagreement activates slot 03', () => {
    expect(evaluateMaterialVerdictConflict('accept', 'accept')).toBe('no-conflict');
    expect(evaluateMaterialVerdictConflict('material-findings', 'material-findings')).toBe('no-conflict');
    expect(evaluateMaterialVerdictConflict('accept', 'material-findings')).toBe('conflict-requires-slot-03');
    expect(evaluateMaterialVerdictConflict('blocked', 'accept')).toBe('blocked-initial-source');
  });
});

describe('conditional topology settlement', () => {
  it('records not-activated slot 03 when the first two verdicts agree', () => {
    const input = normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'scripts/lib/review-lane-0.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-1.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-2.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-3.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-4.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-5.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-6.ts', behaviors: ['pure-review-lane-selection'] },
    ]));
    const classification = classifyReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'scripts/lib/review-lane-0.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-1.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-2.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-3.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-4.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-5.ts', behaviors: ['pure-review-lane-selection'] },
      { kind: 'exact', path: 'scripts/lib/review-lane-6.ts', behaviors: ['pure-review-lane-selection'] },
    ]));
    if (input.status !== 'usable') throw new Error('fixture must be usable');
    const routing = buildReviewLaneRouting(input, classification, 'r1', 'attempt-1');
    const settled = settleReviewLane(routing, {
      '01': 'accept',
      '02': 'accept',
    });
    expect(settled.ok).toBe(true);
    expect(settled.finalRequiredSlots).toEqual(['01', '02']);
    expect(settled.slotCensus).toEqual([
      { slot: '01', state: 'activated' },
      { slot: '02', state: 'activated' },
      { slot: '03', state: 'not-activated' },
    ]);
  });

  it('activates exactly slot 03 for a material verdict conflict and fails closed on blocked sources', () => {
    const input = normalizeReviewLaneDeclaration(declaration(Array.from({ length: 7 }, (_, index) => ({
      kind: 'exact' as const,
      path: `scripts/lib/review-lane-${index}.ts`,
      behaviors: ['pure-review-lane-selection'],
    }))));
    const classification = classifyReviewLaneDeclaration(declaration(Array.from({ length: 7 }, (_, index) => ({
      kind: 'exact' as const,
      path: `scripts/lib/review-lane-${index}.ts`,
      behaviors: ['pure-review-lane-selection'],
    }))));
    if (input.status !== 'usable') throw new Error('fixture must be usable');
    const routing = buildReviewLaneRouting(input, classification, 'r1', 'attempt-1');
    expect(settleReviewLane(routing, {
      '01': 'accept',
      '02': 'material-findings',
      '03': 'material-findings',
    }).finalRequiredSlots).toEqual(['01', '02', '03']);
    expect(settleReviewLane(routing, {
      '01': 'blocked',
      '02': 'accept',
    })).toMatchObject({ ok: false, conflictDecision: 'blocked-initial-source' });
  });
});

expect(REVIEW_LANE_CLASSIFIER_POLICY_VERSION).toBe('review-lane-classifier/v1');
expect(REVIEW_LANE_ROUTING_POLICY_VERSION).toBe('review-lane-routing/v1');
