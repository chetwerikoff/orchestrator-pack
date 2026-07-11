import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkParkedRoot,
  checkPositiveOutcome,
  checkRcaSpecDisciplineSurfaces,
  normalizeLiveIssue,
  type MockIssue,
} from './draft-discipline.mjs';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/draft-discipline',
);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

function loadMockIssues(name: string): Record<string, MockIssue> {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as Record<string, MockIssue>;
}

function createTempRepoPathFixture() {
  const root = mkdtempSync(path.join(repoRoot, 'draft-discipline-wake-fixture-'));
  const extensionlessDir = path.join(root, 'orchestrator-wake');
  const extensionlessFile = path.join(extensionlessDir, 'token');
  mkdirSync(extensionlessDir, { recursive: true });
  writeFileSync(extensionlessFile, 'fixture\n', 'utf8');
  return {
    root,
    extensionlessToken: path.relative(repoRoot, extensionlessFile).replaceAll(path.sep, '/'),
  };
}

function createTopLevelExtensionlessRepoFileFixture() {
  const token = `draftdisciplinewakefixture${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const filePath = path.join(repoRoot, token);
  writeFileSync(filePath, 'fixture\n', 'utf8');
  return { filePath, token };
}

describe('checkPositiveOutcome', () => {
  it('flags action-producing drafts with only negative outcomes', () => {
    const result = checkPositiveOutcome(loadFixture('negative-only-action.md'));
    expect(result.skipped).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/positive-outcome/);
  });

  it('passes when a realistic-input positive-outcome block is present', () => {
    const result = checkPositiveOutcome(loadFixture('positive-present-action.md'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails record-only drafts that read action-producing', () => {
    const result = checkPositiveOutcome(loadFixture('synonym-record-only-backstop.md'));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/record-only/);
    expect(result.errors.join(' ')).toMatch(/supervisor|reconcile/);
  });

  it('flags external-tool positive outcomes without provenance', () => {
    const result = checkPositiveOutcome(loadFixture('external-input-no-provenance.md'));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/provenance/);
  });

  it('excludes taxonomy hits inside a machine-parsed fence label', () => {
    const result = checkPositiveOutcome(`# Named-fence fixture

GitHub Issue: TBD

## Goal

This note records existing references without assigning action to the draft.

\`\`\`behavior-kind
record-only
\`\`\`

\`\`\`denylist
scripts/orchestrator-wake-supervisor.ps1
\`\`\`

\`\`\`allowed-roots
scripts/fixtures/orchestrator-wake-supervisor/
\`\`\`
`);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('still counts a taxonomy hit inside an anonymous or unlabeled code fence', () => {
    const result = checkPositiveOutcome(`# Anonymous-fence fixture

GitHub Issue: TBD

## Goal

This note records existing references without assigning action to the draft.

\`\`\`behavior-kind
record-only
\`\`\`

\`\`\`
The supervisor reconciles wake retries.
\`\`\`
`);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/record-only/);
    expect(result.errors.join(' ')).toMatch(/supervisor|reconcile|wake/);
  });

  it('excludes taxonomy hits inside a token resolving to a real repository path', () => {
    const fixture = createTempRepoPathFixture();
    try {
      const result = checkPositiveOutcome(`# Real-path fixture

GitHub Issue: TBD

## Goal

This note records existing references at docs/wake-supervisor-fleet-operator-reference.md, ${fixture.extensionlessToken}, and scripts/fixtures/orchestrator-wake-supervisor/.

\`\`\`behavior-kind
record-only
\`\`\`
`);

      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('excludes taxonomy hits inside a top-level extensionless token resolving to a real repository path', () => {
    const fixture = createTopLevelExtensionlessRepoFileFixture();
    try {
      const result = checkPositiveOutcome(`# Root-token fixture

GitHub Issue: TBD

## Goal

This note records existing references at ${fixture.token} without assigning new work.

\`\`\`behavior-kind
record-only
\`\`\`
`);

      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(fixture.filePath, { force: true });
    }
  });

  it('still counts a taxonomy hit inside a path-looking token that does not resolve to a real repository path', () => {
    const result = checkPositiveOutcome(`# Fake-path fixture

GitHub Issue: TBD

## Goal

This note records existing references at docs/not-a-real-wake-supervisor.md.

\`\`\`behavior-kind
record-only
\`\`\`
`);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/record-only/);
    expect(result.errors.join(' ')).toMatch(/wake|supervisor/);
  });

  it('still fails record-only drafts with a bare taxonomy term in ordinary prose', () => {
    const result = checkPositiveOutcome(`# Bare-prose fixture

GitHub Issue: TBD

## Goal

This note records an existing supervisor reference without adding new work.

\`\`\`behavior-kind
record-only
\`\`\`
`);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/record-only/);
    expect(result.errors.join(' ')).toMatch(/supervisor/);
  });

  it('still fails record-only drafts that plainly attribute action to themselves', () => {
    const result = checkPositiveOutcome(`# Self-attributed action fixture

GitHub Issue: TBD

## Goal

This draft wakes the review listener when CI turns green.

\`\`\`behavior-kind
record-only
\`\`\`
`);

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/record-only/);
    expect(result.errors.join(' ')).toMatch(/wake|listener/);
  });

  it('passes both guard CLIs end-to-end on a path-and-fence-only record-only fixture', () => {
    const fixture = createTempRepoPathFixture();
    const tempDir = mkdtempSync(path.join(tmpdir(), 'draft-discipline-e2e-'));
    const draftPath = path.join(tempDir, 'issue-733-record-only.md');
    try {
      writeFileSync(
        draftPath,
        `# End-to-end fixture

GitHub Issue: TBD

## Goal

This note records existing references at docs/wake-supervisor-fleet-operator-reference.md, ${fixture.extensionlessToken}, and scripts/fixtures/orchestrator-wake-supervisor/.

\`\`\`behavior-kind
record-only
\`\`\`

\`\`\`complexity-tier
tier: T2
advisory-prior: T2
\`\`\`

## Acceptance criteria

1. Existing references are recorded without assigning action to the draft.

   \`\`\`producer-emission
   producer: orchestrator-pack-scripts
   datum: checkPositiveOutcome:e2e-path-and-fence-fixture
   expected: 0
   proof-command: pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath <temp-file>
   \`\`\`

\`\`\`denylist
scripts/review-trigger-reconcile.ps1
\`\`\`

\`\`\`allowed-roots
scripts/fixtures/orchestrator-wake-supervisor/
\`\`\`

## Verification

1. ` + '`pwsh -NoProfile -File scripts/check-tier-gate-guard.ps1 -DraftPath <temp-file>`' + ` exits 0.

## Contract evidence

\`\`\`contract-evidence
binding-id: orchestrator-pack-scripts:checkPositiveOutcome:e2e-path-and-fence-fixture:0
binding: end-to-end path and fence fixture
producer: orchestrator-pack-scripts
binding-type: structured
evidence: NEW(produced-by AC#1)
\`\`\`
`,
        'utf8',
      );

      const tierGate = spawnSync(
        'pwsh',
        ['-NoProfile', '-File', path.join(repoRoot, 'scripts/check-tier-gate-guard.ps1'), '-DraftPath', draftPath],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(tierGate.status, tierGate.stderr || tierGate.stdout).toBe(0);

      const positiveOutcome = spawnSync(
        'pwsh',
        [
          '-NoProfile',
          '-File',
          path.join(repoRoot, 'scripts/check-draft-discipline.ps1'),
          '-Command',
          'positive-outcome',
          '-DraftPath',
          draftPath,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(positiveOutcome.status, positiveOutcome.stderr || positiveOutcome.stdout).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('checkParkedRoot', () => {
  it('fails euphemistic deferral without a structured block', () => {
    const result = checkParkedRoot(loadFixture('defer-without-block.md'));
    expect(result.ok).toBe(false);
    expect(result.deferralWithoutBlock).toBe(true);
  });

  it('fails vague placeholder causes', () => {
    const result = checkParkedRoot(
      loadFixture('parked-vague-cause.md'),
      loadMockIssues('parked-placeholder-issue.json'),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/vague|placeholder|cause statement/);
  });

  it('fails unrelated or closed unresolved follow-up issues', () => {
    const result = checkParkedRoot(
      loadFixture('parked-unrelated-closed.md'),
      loadMockIssues('parked-unrelated-closed.json'),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/closed|cause statement/);
  });

  it('passes a valid parked-root block with an on-topic open issue', () => {
    const result = checkParkedRoot(
      loadFixture('parked-valid.md'),
      loadMockIssues('parked-valid-issues.json'),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when follow-up issue data is absent', () => {
    const result = checkParkedRoot(loadFixture('parked-valid.md'));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/could not be validated/);
  });

  it('fails when issue body shares words but not the declared cause statement', () => {
    const result = checkParkedRoot(
      loadFixture('parked-word-overlap.md'),
      loadMockIssues('parked-word-overlap.json'),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/cause statement/);
  });

  it('fails when a valid parked block coexists with unstructured deferral prose', () => {
    const result = checkParkedRoot(
      loadFixture('parked-dual-deferral.md'),
      loadMockIssues('parked-valid-issues.json'),
    );
    expect(result.ok).toBe(false);
    expect(result.deferralWithoutBlock).toBe(true);
  });

  it('passes a closed follow-up issue when intentionally resolved', () => {
    const result = checkParkedRoot(
      loadFixture('parked-valid.md'),
      loadMockIssues('parked-intentionally-resolved-closed.json'),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('normalizeLiveIssue', () => {
  it('marks COMPLETED closed issues as intentionally resolved', () => {
    const issue = normalizeLiveIssue({
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      title: 'Binding fix',
      body: 'done',
    });
    expect(issue.intentionallyResolved).toBe(true);
  });

  it('marks PR-closed issues as intentionally resolved', () => {
    const issue = normalizeLiveIssue({
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      title: 'Binding fix',
      body: 'done',
      closedByPullRequestsReferences: [{ url: 'https://github.com/org/repo/pull/1' }],
    });
    expect(issue.intentionallyResolved).toBe(true);
  });

  it('does not mark abandoned closed issues as intentionally resolved', () => {
    const issue = normalizeLiveIssue({
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      title: 'Binding fix',
      body: 'done',
    });
    expect(issue.intentionallyResolved).toBe(false);
  });
});

describe('checkRcaSpecDisciplineSurfaces', () => {
  it('confirms each rule reaches its loader surfaces', () => {
    const result = checkRcaSpecDisciplineSurfaces(repoRoot);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });
});
