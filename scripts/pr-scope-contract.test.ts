import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describePrIssueBindingCorrection,
  extractClosingIssueNumber,
  resolvePrIssueBinding,
  resolveIssueNumberForFetch,
} from './pr-scope-contract.ts';
import { evaluatePrScope } from './pr-scope-check.ts';
import { exactClosingIssue } from './worker-smoke-run.ts';
import { uniqueClosingIssue } from './fleet/fleet-wake.ts';
import { evaluateMappingPreflight, extractContractSections, collectAuthoritativeReferences } from './lib/reviewer-contract-mapping.ts';

const liveIssueBody = [
  '```denylist',
  'vendor/**',
  'docs/declarations/**',
  '```',
  '```allowed-roots',
  'scripts/**',
  '```',
].join('\n');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Same PR body through every production consumer of the shared binding rule. */
function consumers(prBody: string) {
  const root = mkdtempSync(join(tmpdir(), 'opk-2900-binding-'));
  roots.push(root);
  const scope = evaluatePrScope({
    repoRoot: root, prBody, issueBody: liveIssueBody,
    prPaths: ['scripts/allowed.ts'], degradedMode: false, forkPr: false,
  });
  return {
    scope,
    scopeIssue: scope.ok ? (scope as { issueNumber?: number }).issueNumber : undefined,
    smoke: exactClosingIssue(prBody),
    fleet: uniqueClosingIssue(prBody),
    review: collectAuthoritativeReferences({ prBody } as Parameters<typeof collectAuthoritativeReferences>[0]),
    fetch: resolveIssueNumberForFetch(prBody),
  };
}

describe('Issue #2900 shared PR-to-Issue binding rule', () => {
  it('binds one closing reference and, absent one, exactly one Part of reference', () => {
    expect(resolvePrIssueBinding('Closes #41')).toEqual({ ok: true, issueNumber: 41, kind: 'closing' });
    expect(resolvePrIssueBinding('Part of #42')).toEqual({ ok: true, issueNumber: 42, kind: 'part-of' });
    expect(resolvePrIssueBinding('PART OF #42')).toMatchObject({ ok: true, issueNumber: 42 });
    expect(extractClosingIssueNumber('Part of #42')).toBe(42);
  });

  it('prefers a closing reference over Part of and never falls back from ambiguous closings', () => {
    expect(resolvePrIssueBinding('Part of #7\nCloses #8')).toEqual({ ok: true, issueNumber: 8, kind: 'closing' });
    expect(resolvePrIssueBinding('Closes #8\nFixes #9\nPart of #7'))
      .toEqual({ ok: false, reason: 'ambiguous-closing', issueNumbers: [8, 9] });
    expect(resolvePrIssueBinding('Part of #7\nPart of #9'))
      .toEqual({ ok: false, reason: 'ambiguous-part-of', issueNumbers: [7, 9] });
    expect(resolvePrIssueBinding('Closes #8\nCloses #8'))
      .toMatchObject({ ok: false, reason: 'ambiguous-closing' });
  });

  it('fails closed on missing, invalid, fenced, commented and foreign references', () => {
    for (const body of ['', 'Refs #5', 'see #5', 'Part of owner/repo#5', 'Part of https://github.com/o/r/issues/5']) {
      expect(resolvePrIssueBinding(body), body).toMatchObject({ ok: false, reason: 'missing' });
    }
    expect(resolvePrIssueBinding('Part of #0')).toMatchObject({ ok: false, reason: 'invalid-reference' });
    expect(resolvePrIssueBinding('Closes #99999999999999999999')).toMatchObject({ ok: false, reason: 'invalid-reference' });
    expect(resolvePrIssueBinding('```\nCloses #5\nPart of #6\n```')).toMatchObject({ ok: false, reason: 'missing' });
    expect(resolvePrIssueBinding('<!-- Closes #5 -->\nPart of #6')).toEqual({ ok: true, issueNumber: 6, kind: 'part-of' });
  });

  it('names a concrete correction for every failure kind', () => {
    for (const body of ['', 'Closes #1\nCloses #2', 'Part of #1\nPart of #2', 'Part of #0']) {
      const binding = resolvePrIssueBinding(body);
      if (binding.ok) throw new Error('expected failure');
      expect(describePrIssueBindingCorrection(binding)).toMatch(/Closes #N|Part of #N/);
    }
  });

  it('review mapping, scope, smoke, fleet attribution and fetch choose the same Issue', () => {
    for (const [body, expected] of [
      ['Closes #41', 41], ['Part of #42', 42], ['Part of #7\nCloses #8', 8],
    ] as const) {
      const row = consumers(body);
      expect(row.smoke, body).toBe(expected);
      expect(row.fleet, body).toBe(expected);
      expect(row.fetch, body).toBe(expected);
      expect(row.review, body).toEqual([expected]);
      expect(row.scope, body).toMatchObject({ ok: true, mode: 'implementation' });
      expect(row.scopeIssue, body).toBe(expected);
    }
  });

  it('every consumer rejects ambiguous and missing bindings without selecting an Issue', () => {
    for (const body of ['Closes #8\nFixes #9', 'Part of #7\nPart of #9', 'Refs #5', '']) {
      const row = consumers(body);
      expect(row.smoke, body).toBeUndefined();
      expect(row.fleet, body).toBeUndefined();
      expect(row.fetch, body).toBeNull();
      expect(row.scope.ok, body).toBe(false);
      if (!row.scope.ok) {
        expect(row.scope.message, body).toMatch(/Closes #N|closing Issue reference/);
      }
    }
    // Ambiguous references stay visible to the reviewer mapping so it cannot bind one silently.
    expect(consumers('Closes #8\nFixes #9').review).toEqual([0, 8, 9]);
  });

  it('keeps explicit and declaration Issue mismatches visible to the reviewer mapping', () => {
    const refs = collectAuthoritativeReferences({
      prBody: 'Part of #5', explicitIssueNumber: 6, declarationIssueNumber: 7,
    } as Parameters<typeof collectAuthoritativeReferences>[0]);
    expect(refs).toEqual([5, 6, 7]);
  });
});

describe('Issue #2900 behavior-criteria reader on the review mapping', () => {
  const body = (heading: string, text = '1. **One.** Works.') =>
    `## Goal\nG\n\n## Binding surface\nB\n\n## ${heading}\n\n${text}\n\n## Verification\nV\n`;

  it('accepts exactly one Acceptance criteria or Fix criteria section into the same slot', () => {
    for (const heading of ['Acceptance criteria', 'Fix criteria', 'fix CRITERIA']) {
      const extracted = extractContractSections(body(heading));
      expect(extracted.complete, heading).toBe(true);
      expect(extracted.sections['Acceptance criteria'], heading).toBe('1. **One.** Works.');
    }
  });

  it('rejects zero, duplicate, mixed and empty criteria sections', () => {
    const base = body('Fix criteria');
    for (const [label, issue] of [
      ['zero', body('Notes')],
      ['duplicate fix', `${base}\n## Fix criteria\n1. Another.\n`],
      ['duplicate acceptance', `${body('Acceptance criteria')}\n## Acceptance criteria\n1. Another.\n`],
      ['mixed', `${base}\n## Acceptance criteria\n1. Another.\n`],
      ['empty', body('Fix criteria', '')],
    ] as const) {
      const extracted = extractContractSections(issue);
      expect(extracted.complete, label).toBe(false);
      expect(extracted.missing, label).toContain('Acceptance criteria');
    }
  });
});

describe('Issue #2900 review mapping preflight fails closed on an unbound PR body', () => {
  const spec = '## Goal\nG\n\n## Binding surface\nB\n\n## Fix criteria\n\n1. Works.\n\n## Verification\nV\n';
  const preflight = (prBody: string) => evaluateMappingPreflight({
    diffLineCount: 500, diffContent: '', changedPaths: ['scripts/a.ts'],
    binding: { prBody } as Parameters<typeof collectAuthoritativeReferences>[0],
    specBodies: [{ issueNumber: 8, body: spec }],
  } as Parameters<typeof evaluateMappingPreflight>[0]);

  it.each(['Closes #8\nCloses #8', 'Closes #8\nFixes #0', 'Part of #8\nPart of #8'])('%j never selects a contract', (body) => {
    expect(preflight(body).status).toBe('ambiguous_spec');
    expect(preflight(body).contractSet).toEqual([]);
  });

  it.each(['Closes #8', 'Part of #8'])('%j selects the Fix criteria contract of Issue 8', (body) => {
    expect(preflight(body).status).not.toBe('ambiguous_spec');
  });
});

describe('Issue #2900 reviewer reference set never collapses an unresolved PR binding to one Issue', () => {
  it.each(['Closes #8\nCloses #8', 'Closes #8\nFixes #0', 'Part of #8\nPart of #8'])('%j carries the unresolved marker', (prBody) => {
    const refs = collectAuthoritativeReferences({ prBody } as Parameters<typeof collectAuthoritativeReferences>[0]);
    expect(refs).toContain(0);
    expect(refs.length).toBeGreaterThan(1);
  });

  it('a missing or valid binding carries no marker', () => {
    expect(collectAuthoritativeReferences({ prBody: 'Closes #8' } as Parameters<typeof collectAuthoritativeReferences>[0])).toEqual([8]);
    expect(collectAuthoritativeReferences({ prBody: 'no ref' } as Parameters<typeof collectAuthoritativeReferences>[0])).toEqual([]);
  });
});
