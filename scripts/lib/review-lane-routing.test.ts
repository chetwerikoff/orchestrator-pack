import { describe, expect, it } from 'vitest';
import {
  REVIEW_LANE_CLASSIFIER_POLICY_VERSION,
  REVIEW_LANE_ROUTING_POLICY_VERSION,
  buildReviewLaneRouting,
  classifyReviewLaneDeclaration,
  evaluateMaterialVerdictConflict,
  freezeConsistentReviewLaneBody,
  normalizeReviewLaneDeclaration,
  normalizeMaterialVerdict,
  reviewLaneClassifierPolicyIdentity,
  settleReviewLane,
  type ReviewLaneAuthorDeclaration,
  type ReviewLaneBodyRead,
} from './review-lane-routing.ts';
import { produceReviewLaneInput } from './review-lane-input.ts';
import { selectReviewLane } from './review-lane-selector.ts';

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

    const browserFamily = normalizeReviewLaneDeclaration(declaration([
      { kind: 'family', path: 'scripts/chatgpt-browser-turn/**', behaviors: ['pure-review-lane-selection'] },
    ]));
    expect(browserFamily).toMatchObject({ status: 'usable', blastRadius: 'high' });

    const seven = normalizeReviewLaneDeclaration(declaration(Array.from({ length: 7 }, (_, index) => ({
      kind: 'exact' as const,
      path: `scripts/lib/review-lane-${index}.ts`,
      behaviors: ['pure-review-lane-selection'],
    }))));
    expect(seven.status).toBe('usable');
    if (seven.status === 'usable') expect(seven.blastRadius).toBe('high');
  });

  it('admits browser-turn paths with high blast radius for the security lane', () => {
    const value = declaration([
      { kind: 'exact', path: 'scripts/chatgpt-browser-turn/driver.ts', behaviors: ['pure-review-lane-selection'] },
    ]);
    const input = normalizeReviewLaneDeclaration(value);
    const classification = classifyReviewLaneDeclaration(value);

    expect(input).toMatchObject({ status: 'usable', blastRadius: 'high' });
    expect(classification).toMatchObject({ policyStatus: 'available', scopeClass: 'security-sensitive' });
    if (input.status !== 'usable') return;
    expect(buildReviewLaneRouting(input, classification, 'r1', 'attempt-browser-turn')).toMatchObject({
      lane: 'disputed',
      topology: 'fixed/v1',
    });
  });

  it('classifies normalized browser-turn paths as security-sensitive', () => {
    const value = declaration([
      { kind: 'exact', path: '  ./scripts/chatgpt-browser-turn/x.ts  ', behaviors: ['pure-review-lane-selection'] },
    ]);
    const input = normalizeReviewLaneDeclaration(value);
    const classification = classifyReviewLaneDeclaration(value);

    expect(input).toMatchObject({ status: 'usable', blastRadius: 'high' });
    expect(classification).toMatchObject({ policyStatus: 'available', scopeClass: 'security-sensitive' });
    expect(classification.paths[0]).toMatchObject({
      path: 'scripts/chatgpt-browser-turn/x.ts',
      scopeClass: 'security-sensitive',
    });
  });

  it('rejects wildcard syntax in exact declaration entries', () => {
    const result = normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
    ]));
    expect(result).toMatchObject({ status: 'author-revision-required', reason: 'declaration-malformed' });
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
    for (const path of [
      'vendor/example.ts',
      'packages/core/example.ts',
      '.ao/state.json',
      '.github/workflows/check.yml',
      'prompts/example.md',
      'agent-orchestrator.yaml',
      'agent-orchestrator.local.yaml',
    ]) {
      expect(normalizeReviewLaneDeclaration(declaration([
        { kind: 'exact', path, behaviors: ['documentation-only'] },
      ])).reason, path).toBe('declared-path-denied');
    }
    expect(normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'src/new.ts', behaviors: ['pure-review-lane-selection'] },
    ])).reason).toBe('declared-path-outside-allowed-roots');
    expect(normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: '../scripts/new.ts', behaviors: ['pure-review-lane-selection'] },
    ])).reason).toBe('path-not-repository-relative');
  });

  it('rejects nested secret names and case variants before allowed-root checks', () => {
    for (const path of [
      'scripts/lib/my-secret.ts',
      'scripts/lib/nested/SECRET.config.ts',
      'scripts/lib/review-lane-safe/secret-policy.ts',
      'scripts/chatgpt-browser-turn/credential-helper.ts',
      'scripts/chatgpt-browser-turn/nested/.env.production.ts',
      'scripts/chatgpt-browser-turn/secret/nested.ts',
      'scripts/chatgpt-browser-turn/credentials/nested.ts',
      'scripts/chatgpt-browser-turn/.env/nested.ts',
    ]) {
      expect(normalizeReviewLaneDeclaration(declaration([
        { kind: 'exact', path, behaviors: ['pure-review-lane-selection'] },
      ])).reason).toBe('declared-path-denied');
    }
  });

  it('accepts every Issue-bound infrastructure root before classification', () => {
    const paths = [
      'scripts/vitest-ci-lanes.config.json',
      'scripts/lib/vitest-pre-topology-measurement.mjs',
      'scripts/vitest-runtime-history.json',
      'agent-orchestrator.yaml.example',
      'docs/migration_notes.md',
      'scripts/lib/any-new-helper.ts',
    ];
    for (const path of paths) {
      expect(normalizeReviewLaneDeclaration(declaration([
        { kind: path === 'scripts/lib/any-new-helper.ts' ? 'family' : 'exact', path, behaviors: ['pure-review-lane-selection'] },
      ]), `path should be within the Issue allowed roots: ${path}`)).toMatchObject({ status: 'usable' });
    }
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

  it('keeps access-control security precedence across every broad safe family', () => {
    const fixtures = [
      ['docs/declarations/access-control.ts', ['scope-declaration-only']],
      ['.claude/skills/create-issue-draft/access-control.ts', ['author-declaration-validation', 'review-source-cardinality-only']],
      ['.claude/skills/discuss-with-gpt/access-control.ts', ['review-source-cardinality-only']],
      ['.cursor/skills/create-issue-draft/access-control.ts', ['generated-parity-only', 'review-source-cardinality-only']],
      ['.cursor/skills/discuss-with-gpt/access-control.ts', ['generated-parity-only', 'review-source-cardinality-only']],
      ['scripts/lib/create-issue-stage-record-access-control.ts', ['additive-existing-receipt-evidence', 'routing-policy-epoch']],
      ['scripts/lib/review-lane-access-control.ts', ['pure-review-lane-selection']],
      ['scripts/lib/review-lane-access-control.test.ts', ['test-only']],
    ] as const;
    for (const [path, behaviors] of fixtures) {
      const result = classifyReviewLaneDeclaration(declaration([
        { kind: 'exact', path, behaviors: [...behaviors] },
      ]));
      expect(result.scopeClass, path).toBe('security-sensitive');
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

  it('keeps safe high-or-uncertain families on the conditional third-source topology', () => {
    const input = normalizeReviewLaneDeclaration(declaration([
      { kind: 'family', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
    ]));
    const classification = classifyReviewLaneDeclaration(declaration([
      { kind: 'family', path: 'scripts/lib/review-lane-*.ts', behaviors: ['pure-review-lane-selection'] },
    ]));
    expect(input.status).toBe('usable');
    if (input.status !== 'usable') return;
    expect(input.blastRadius).toBe('high-or-uncertain');
    expect(buildReviewLaneRouting(input, classification, 'r1', 'attempt-family').topology).toBe('conditional-third/v1');
  });

  it('persists the permitted lane override in immutable routing evidence', () => {
    const input = normalizeReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'docs/review-lanes.md', behaviors: ['documentation-only'] },
    ]));
    const classification = classifyReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'docs/review-lanes.md', behaviors: ['documentation-only'] },
    ]));
    if (input.status !== 'usable') throw new Error('override fixture input must be usable');
    const selected = selectReviewLane(input, classification, 'r1', 'attempt-override', 'disputed');
    expect(selected.routing?.permittedLaneOverride).toBe('disputed');
  });

  it('selects the specific test rule before the broad review-lane production rule', () => {
    const result = classifyReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'scripts/lib/review-lane-routing.test.ts', behaviors: ['test-only'] },
    ]));
    expect(result.scopeClass).toBe('safe');
    expect(result.paths[0]?.matchedRule).toBe('scripts/lib/review-lane-*.test.ts');
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

  it('requires a verified digest before accepting a clean verdict', () => {
    expect(normalizeMaterialVerdict({
      terminalClassification: 'complete',
      captureVerified: true,
      verdictText: 'NO_FINDINGS',
    })).toBe('unparseable');
    expect(normalizeMaterialVerdict({
      terminalClassification: 'complete',
      captureVerified: true,
      digestMatches: true,
      verdictText: 'NO_FINDINGS',
    })).toBe('accept');
  });

  it('binds classifier identity to canonical policy bytes', () => {
    const current = classifyReviewLaneDeclaration(declaration([
        { kind: 'exact', path: 'docs/review-lanes.md', behaviors: ['documentation-only'] },
      ]));
    expect(reviewLaneClassifierPolicyIdentity()).toBe(current.policyIdentity);
    expect(reviewLaneClassifierPolicyIdentity()).not.toBe(REVIEW_LANE_CLASSIFIER_POLICY_VERSION);
    expect(classifyReviewLaneDeclaration(declaration([
      { kind: 'exact', path: 'docs/review-lanes.md', behaviors: ['documentation-only'] },
    ]), REVIEW_LANE_CLASSIFIER_POLICY_VERSION)).toMatchObject({
      policyStatus: 'unavailable',
      unavailableReason: 'classifier-identity-mismatch',
    });
  });

  it('normalizes the live YAML-like declaration fence', () => {
    const result = produceReviewLaneInput(`before

\`\`\`review-lane-change-set/v1
schema: review-lane-change-set/v1
owner: issue-author
entries:
  - kind: exact
    path: docs/tiering.md
    behaviors: [documentation-only, tier-lane-orthogonality]
\`\`\`
after`, 'r7');
    expect(result.status).toBe('usable');
    if (result.status === 'usable') expect(result.entries[0]?.path).toBe('docs/tiering.md');
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
    const blocked = settleReviewLane(routing, {
      '01': 'blocked',
      '02': 'accept',
    });
    expect(blocked).toMatchObject({ ok: false, conflictDecision: 'blocked-initial-source' });
    expect(blocked.finalRequiredSlots).toEqual(['01', '02']);
  });
});

expect(REVIEW_LANE_CLASSIFIER_POLICY_VERSION).toBe('review-lane-classifier/v1');
expect(REVIEW_LANE_ROUTING_POLICY_VERSION).toBe('review-lane-routing/v1');
