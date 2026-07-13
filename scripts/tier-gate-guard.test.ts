import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkTierGateGuard,
  checkWorkerSafetyFloor,
  FLOOR_CHECKS,
  selectAuthoringReviewStages,
} from './lib/tier-gate-core.js';
import { runCli } from './tier-gate-guard.js';
import {
  loadMarkerClasses,
  MARKER_HEURISTICS,
  maskDelimitedMarkdownQuotes,
  screenRedFlagMarkers,
} from './lib/tier-marker-screen.js';
import { validateTierGateGuardReceipt } from './lib/publish-issue-body-sync.js';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/tier-gate',
);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadFixture(name: string) {
  return readFileSync(path.join(fixturesDir, `${name}.md`), 'utf8');
}

function fixturePath(name: string) {
  return path.join(fixturesDir, `${name}.md`);
}

function markerVocabularyDraft(goal: string, examples = '') {
  return `# Quotation marker vocabulary T1 brief

GitHub Issue: TBD

\`\`\`complexity-tier
tier: T1
advisory-prior: T1
\`\`\`

\`\`\`behavior-kind
action-producing
\`\`\`

\`\`\`contract-evidence
none
\`\`\`

\`\`\`positive-outcome
asserts: marker screening keeps quoted examples separate from operative prose
input: realistic
\`\`\`

## Goal

${goal}

${examples}

## Denylist

\`\`\`denylist
vendor/**
packages/core/**
\`\`\`

\`\`\`allowed-roots
scripts/lib/tier-marker-screen.ts
\`\`\`

## Acceptance criteria

1. Marker behavior is stable.

## Verification

1. Run the tier-gate guard.
`;
}

describe('tier-gate guard fails a red-flag-marked task assigned below T3 and passes a marker-free task on its lower tier', () => {
  it('fails when a red-flag marker phrase coincides with a T1 fence', () => {
    const text = loadFixture('marker-hit-sub-t3-brief');
    const result = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('marker-hit-sub-t3-brief'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/below T3|ci-review-gating/);
    expect(screenRedFlagMarkers(text).hits).toContain('ci-review-gating');
  });

  it('passes a marker-free T1 brief with required worker-safety floor', () => {
    const text = loadFixture('marker-free-t1-brief');
    const result = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('marker-free-t1-brief'),
    });
    expect(result.ok).toBe(true);
    expect(result.receipt?.kind).toBe('tier-fence');
    if (result.receipt?.kind === 'tier-fence') {
      expect(result.receipt.tier).toBe('T1');
    }
  });

  it('fails when design/adversarial stages are skipped on a marked brief', () => {
    const text = loadFixture('marker-hit-sub-t3-brief');
    const result = checkTierGateGuard(text, {
      tier: 'T3',
      designSkipped: true,
      adversarialSkipped: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/design-analysis|adversarial/);
  });

  it('passes skip-line input after marker screen is clean', () => {
    const text = loadFixture('skip-line-brief');
    const result = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('skip-line-brief'),
    });
    expect(result.ok).toBe(true);
    expect(result.receipt?.kind).toBe('no-tier');
  });

  it('exits non-zero on CLI for marker+sub-T3 fixture', () => {
    const fixtureFile = path.join(fixturesDir, 'marker-hit-sub-t3-brief.md');
    expect(
      runCli(['node', 'tier-gate-guard.ts', '--text-file', fixtureFile, '--repo-root', repoRoot, '--draft-path', fixtureFile]),
    ).toBe(1);
  });

  it('exits zero on CLI for marker-free T1 fixture', () => {
    const fixtureFile = path.join(fixturesDir, 'marker-free-t1-brief.md');
    expect(
      runCli(['node', 'tier-gate-guard.ts', '--text-file', fixtureFile, '--repo-root', repoRoot, '--draft-path', fixtureFile]),
    ).toBe(0);
  });

  it('fails when tier override cannot mask a missing complexity-tier fence', () => {
    const text = loadFixture('marker-free-t1-brief').replace(
      /```complexity-tier\s*\n[\s\S]*?```\n?/i,
      '',
    );
    const result = checkTierGateGuard(text, {
      tier: 'T3',
      repoRoot,
      draftPath: fixturePath('marker-free-t1-brief'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unparseable complexity-tier fence/);
    expect(result.receipt).toBeNull();
  });

  it('fails when tier override cannot mask an invalid complexity-tier fence', () => {
    const text = loadFixture('marker-free-t1-brief').replace(
      'tier: T1',
      'tier: T9',
    );
    const result = checkTierGateGuard(text, {
      tier: 'T3',
      repoRoot,
      draftPath: fixturePath('marker-free-t1-brief'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/unparseable complexity-tier fence/);
    expect(result.receipt).toBeNull();
  });

  it('accepts draft-275-shaped quoted marker vocabulary through core, wrapper, and sync validation', () => {
    const text = markerVocabularyDraft(
      "Document the marker screen's quotation handling without editing marker classes.",
      [
        '## Examples',
        'Inline code span: `required checks`',
        '',
        'Fenced code block:',
        '',
        '```text',
        'branch protection',
        '```',
        '',
        'Rubric row:',
        '',
        '> T3 | ci-review-gating | merge authorization',
        '',
        'Quoted regex pattern: "\\\\brequired\\\\s+checks?\\\\b"',
        '',
        "Quoted test-fixture string: 'Change external API timeout semantics for the REST wrapper.'",
      ].join('\n'),
    );

    const core = checkTierGateGuard(text, { repoRoot });
    expect(core.ok).toBe(true);
    expect(core.screen.hits).toEqual([]);
    expect(runCli(['node', 'tier-gate-guard.ts', '--text', text, '--repo-root', repoRoot])).toBe(0);
    expect(validateTierGateGuardReceipt(text).ok).toBe(true);
  });

  it('rejects unquoted and mixed marker vocabulary below T3 through the same tier-gate paths', () => {
    const cases = new Map([
      [
        'unquoted',
        markerVocabularyDraft('Operate on required checks and branch protection for merge authorization.'),
      ],
      [
        'mixed',
        markerVocabularyDraft('Document `required checks`, then operate on branch protection for merge.'),
      ],
      [
        'malformed',
        markerVocabularyDraft('Discuss the unterminated example "required checks without closing it.'),
      ],
    ]);

    for (const [name, text] of cases) {
      const core = checkTierGateGuard(text, { repoRoot });
      expect(core.ok, name).toBe(false);
      expect(core.screen.hits.length, name).toBeGreaterThan(0);
      expect(runCli(['node', 'tier-gate-guard.ts', '--text', text, '--repo-root', repoRoot])).toBe(1);
      expect(validateTierGateGuardReceipt(text).ok).toBe(false);
    }
  });

  it('documents the tier marker quotation delimiter forms and fail-closed malformed behavior', () => {
    const examples = [
      'Inline code span: `required checks`',
      ['```text', 'branch protection', '```'].join('\n'),
      '> T3 | ci-review-gating | merge authorization\n',
      '"\\brequired\\s+checks?\\b"',
      "'Change external API timeout semantics for the REST wrapper.'",
    ];

    for (const example of examples) {
      expect(screenRedFlagMarkers(example, { repoRoot }).hits, example).toEqual([]);
      expect(maskDelimitedMarkdownQuotes(example), example).not.toMatch(/required checks|branch protection|merge authorization|external API timeout semantics/i);
    }

    expect(screenRedFlagMarkers('"required checks', { repoRoot }).hits).toContain('ci-review-gating');
  });

  it('does not treat apostrophe contractions as quoted marker spans', () => {
    const text = "Don't change required checks because it's risky.";
    expect(maskDelimitedMarkdownQuotes(text)).toContain('required checks');
    expect(screenRedFlagMarkers(text, { repoRoot }).hits).toContain('ci-review-gating');
  });

  it('does not hide operative inline-code marker phrases', () => {
    const text = 'Update the `required checks` configuration before merge.';
    expect(maskDelimitedMarkdownQuotes(text)).toContain('required checks');
    expect(screenRedFlagMarkers(text, { repoRoot }).hits).toContain('ci-review-gating');
  });
});

describe('floor on every tier', () => {
  it('includes all never-skipped floor checks on a T1-tier fixture run', () => {
    const text = loadFixture('marker-free-t1-brief');
    const stages = selectAuthoringReviewStages({ tier: 'T1', skipLine: false });
    expect(stages.floor).toEqual(FLOOR_CHECKS);
    expect(stages.authoring).toEqual([]);
    expect(stages.review).toEqual(['light-architectural']);
  });

  it('fails when a T1 draft is missing allowed-roots/denylist worker-safety fences', () => {
    const text = loadFixture('t1-missing-floor-brief');
    const floor = checkWorkerSafetyFloor(text);
    expect(floor.ok).toBe(false);
    const gate = checkTierGateGuard(text, { repoRoot, draftPath: fixturePath('t1-missing-floor-brief') });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/denylist|allowed-roots|Verification/);
  });

  it('fails when a T1 draft is missing behavior-kind floor', () => {
    const text = loadFixture('t1-missing-behavior-kind-brief');
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('t1-missing-behavior-kind-brief'),
    });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/behavior-kind/);
  });

  it('fails when a T1 draft is missing contract-evidence floor', () => {
    const text = loadFixture('t1-missing-contract-evidence-brief');
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('t1-missing-contract-evidence-brief'),
    });
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toMatch(/contract-evidence/);
  });

  it('fails when a draft has denylist but no allowed-roots fence', () => {
    const text = loadFixture('denylist-only-missing-allowed-roots-brief');
    const floor = checkWorkerSafetyFloor(text);
    expect(floor.ok).toBe(false);
    expect(floor.errors.join(' ')).toMatch(/allowed-roots/);
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('denylist-only-missing-allowed-roots-brief'),
    });
    expect(gate.ok).toBe(false);
  });

  it('wrapper-invoked T1 recompute selects a path at least T2 with adversarial stage', () => {
    const text = loadFixture('marker-free-t1-brief');
    const stages = selectAuthoringReviewStages({
      tier: 'T1',
      skipLine: false,
      explicitAdversarialWrapper: true,
    });
    expect(stages.effectiveTier).toBe('T2');
    expect(stages.review).toContain('competitive-adversarial');
    const gate = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('marker-free-t1-brief'),
      explicitAdversarialWrapper: true,
    });
    expect(gate.ok).toBe(true);
    if (gate.receipt?.kind === 'tier-fence') {
      expect(gate.receipt.wrapperFloorApplied).toBe(true);
    }
  });
});

describe('red-flag marker vocabulary (#574 / #187 verbatim)', () => {
  const calibration = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'tests/fixtures/task-complexity-tier-calibration.json'),
      'utf8',
    ),
  ) as {
    markerClasses: string[];
    samples: Array<{ id: string; task: string; markersPresent: string[]; tier: string }>;
  };

  it('maps every calibration marker class to heuristic patterns', () => {
    for (const markerClass of loadMarkerClasses(repoRoot)) {
      expect(MARKER_HEURISTICS[markerClass]?.length).toBeGreaterThan(0);
    }
  });

  it('detects every #187 vocabulary phrase class before allowing lower tiers', () => {
    const phrases: Record<string, string> = {
      'trust-boundary': 'Task touches auth surfaces for merge authorization.',
      'spawn-capability': 'Bind autonomous spawn grants to named worktree provenance.',
      'concurrency-state-retry': 'Add shared-machine claim semantics and event-ordering.',
      'ci-review-gating': 'Change required checks and branch protection for merge.',
      'durable-state-evidence': 'Mutate operator-visible contract-evidence ledger rows.',
      'test-harness-correctness': 'Fix fixtures touching live AO session state.',
      'crash-recovery': 'Handle orphaned claims during crash/recovery restart mid-phase.',
      'external-api-transport': 'Change external API timeout semantics for the REST wrapper.',
      'shared-contract-dependency': 'Introduce a new contract ≥2 future issues will depend on.',
      'multi-surface': 'Change spans multiple otherwise-independent surfaces at once.',
      ambiguity: 'This draft leaves genuine ambiguity in what is being asked.',
    };

    for (const [markerClass, phrase] of Object.entries(phrases)) {
      const screen = screenRedFlagMarkers(phrase, { repoRoot });
      expect(screen.unparseable).toBe(false);
      expect(screen.hits).toContain(markerClass);
    }
  });

  it('flags external-api timeout semantics on a T1 fence', () => {
    const text = loadFixture('marker-free-t1-brief').replace(
      'Add a Usage subsection to a plugin README documenting existing CLI flags.',
      'Change external API timeout semantics for the REST wrapper.',
    );
    const result = checkTierGateGuard(text, {
      repoRoot,
      draftPath: fixturePath('marker-free-t1-brief'),
    });
    expect(result.ok).toBe(false);
    expect(screenRedFlagMarkers(text).hits).toContain('external-api-transport');
  });

  it('detects markersPresent on every calibration boundary row', () => {
    for (const row of calibration.samples.filter((sample) => sample.markersPresent.length > 0)) {
      const screen = screenRedFlagMarkers(row.task, { repoRoot });
      for (const marker of row.markersPresent) {
        expect(screen.hits, `${row.id} should hit ${marker}`).toContain(marker);
      }
    }
  });

  it('keeps T1/T2 calibration rows marker-silent', () => {
    for (const row of calibration.samples.filter((sample) => sample.tier === 'T1' || sample.tier === 'T2')) {
      const screen = screenRedFlagMarkers(row.task, { repoRoot });
      expect(screen.hits, `${row.id} should stay marker-silent`).toEqual([]);
    }
  });
});

describe('durable-state-evidence marker distinguishes a review-artifact ledger from durable production state', () => {
  const patterns = MARKER_HEURISTICS['durable-state-evidence'];

  it('does not fire on bare "finding-disposition ledger" review-governance prose', () => {
    expect(patterns.some((pattern) => pattern.test('This draft amends the finding-disposition ledger rules.'))).toBe(
      false,
    );
  });

  it('still fires on a durable evidence ledger / provenance / audit-log mechanism', () => {
    expect(patterns.some((pattern) => pattern.test('the worker mutates an evidence ledger'))).toBe(true);
    expect(patterns.some((pattern) => pattern.test('records durable provenance'))).toBe(true);
    expect(patterns.some((pattern) => pattern.test('appends to an audit log'))).toBe(true);
  });
});
