import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkParkedRoot,
  checkPositiveOutcome,
  checkRcaSpecDisciplineSurfaces,
  type MockIssue,
} from './draft-discipline.js';

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

  it('backstops record-only drafts that read action-producing', () => {
    const result = checkPositiveOutcome(loadFixture('synonym-record-only-backstop.md'));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/record-only/);
    expect(result.warnings.join(' ')).toMatch(/supervisor|reconcile/);
  });

  it('flags external-tool positive outcomes without provenance', () => {
    const result = checkPositiveOutcome(loadFixture('external-input-no-provenance.md'));
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/provenance/);
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
});

describe('checkRcaSpecDisciplineSurfaces', () => {
  it('confirms each rule reaches its loader surfaces', () => {
    const result = checkRcaSpecDisciplineSurfaces(repoRoot);
    expect(result.ok, result.errors.join('\n')).toBe(true);
  });
});
