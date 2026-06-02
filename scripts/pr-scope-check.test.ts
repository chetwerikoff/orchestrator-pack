import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLOSING_KEYWORD_ALTERNATION,
  extractClosingIssueNumber,
  extractNonClosingIssueNumber,
  hasClosingIssueReference,
  hasSpecOnlySignal,
  NON_CLOSING_ISSUE_REF_PATTERN,
  SPEC_ONLY_SIGNAL_LITERAL,
} from './pr-scope-contract.js';
import {
  checkPrScope,
  extractLinkedIssueNumber,
  resolveLatestCommittedSnapshot,
} from './pr-scope-check.js';

function writeSnapshot(
  dir: string,
  issueNumber: number,
  iterationId: string,
  input: {
    supersedes: string | null;
    created_at: string;
  },
): void {
  const payload = {
    issue_number: issueNumber,
    iteration_id: iterationId,
    iteration_id_source: 'ao_session',
    supersedes: input.supersedes,
    created_at: input.created_at,
    baseline: {
      commit_sha: 'abc123',
      worktree_dirty: false,
      active_scope_hash: 'sha256:abc',
    },
    declared_paths: ['scripts/pr-scope-check.ts'],
    declared_globs: [],
    amendments: [],
  };
  writeFileSync(
    join(dir, 'docs', 'declarations', `${issueNumber}.${iterationId}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

const SPEC_SIGNAL = SPEC_ONLY_SIGNAL_LITERAL;

describe('extractClosingIssueNumber / extractLinkedIssueNumber', () => {
  it.each([
    ['Closes #6', 6],
    ['Fixes #6', 6],
    ['Resolves #6', 6],
    ['Closed #6', 6],
    ['Fix #6', 6],
    ['Resolve #6', 6],
  ])('accepts GitHub closing keyword in %s', (body, expected) => {
    expect(extractClosingIssueNumber(body)).toBe(expected);
    expect(extractLinkedIssueNumber(body)).toBe(expected);
  });

  it('uses the last closing reference in the body', () => {
    expect(extractClosingIssueNumber('Closes #1\n\nResolves #6')).toBe(6);
  });

  it('finds Closes after summary bullets that contain colons (PR #84 class)', () => {
    const body = [
      '## Summary',
      '',
      '- Adds tracked `scripts/run-pack-review-claude.ps1` (parallel to Codex `run-pack-review.ps1`): npm preflight off stdout.',
      '- More bullets with paths and flags.',
      '',
      '## Test plan',
      '',
      '- [ ] Operator smoke: `ao review run ... --command` with tracked Claude wrapper',
      '',
      'Closes #79',
    ].join('\n');
    expect(extractClosingIssueNumber(body)).toBe(79);
  });
});

describe('spec-only contract parsing', () => {
  it('detects the canonical spec-only signal', () => {
    expect(hasSpecOnlySignal(`## Summary\n\n${SPEC_SIGNAL}\n\nRefs #121`)).toBe(true);
    expect(hasSpecOnlySignal('<!-- PR-TYPE: spec-only -->')).toBe(true);
    expect(hasSpecOnlySignal('Spec only PR')).toBe(false);
  });

  it.each([
    ['Refs #121', 121],
    ['Ref #121', 121],
    ['See #121', 121],
    ['Related to #121', 121],
  ])('extracts non-closing reference from %s', (body, expected) => {
    expect(extractNonClosingIssueNumber(body)).toBe(expected);
  });

  it('does not treat closing keywords as non-closing refs', () => {
    expect(extractNonClosingIssueNumber('Closes #121')).toBeNull();
  });
});

describe('PowerShell must not duplicate closing-keyword regex', () => {
  it('pr-scope-check.ps1 delegates issue-link parsing to TypeScript', () => {
    const ps1 = readFileSync(join('scripts', 'pr-scope-check.ps1'), 'utf8');
    expect(ps1).toContain('--resolve-issue-number');
    expect(ps1).not.toMatch(
      new RegExp(`\\\\b\\(?:${CLOSING_KEYWORD_ALTERNATION.replace(/\|/g, '\\|')}\\)`),
    );
  });

  it('NON_CLOSING_ISSUE_REF_PATTERN stays aligned with documented Refs form', () => {
    expect(NON_CLOSING_ISSUE_REF_PATTERN.test('Refs #1')).toBe(true);
    expect(NON_CLOSING_ISSUE_REF_PATTERN.test('Closes #1')).toBe(false);
  });
});

describe('resolve-issue-number CLI (PowerShell entrypoint parity)', () => {
  const checkScript = join('scripts', 'pr-scope-check.ts');

  function resolveViaCli(prBody: string): number | null {
    const payloadPath = join(tmpdir(), `scope-guard-cli-${randomUUID()}.json`);
    writeFileSync(payloadPath, JSON.stringify({ prBody }), 'utf8');
    try {
      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', checkScript, '--resolve-issue-number', '--input', payloadPath],
        {
          encoding: 'utf8',
          cwd: process.cwd(),
        },
      );
      const parsed = JSON.parse(output) as { issueNumber: number | null };
      return parsed.issueNumber;
    } finally {
      try {
        unlinkSync(payloadPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  it.each([
    ['Closes #6', 6],
    ['Fixes #6', 6],
    [`${SPEC_ONLY_SIGNAL_LITERAL}\nRefs #121`, 121],
  ])('CLI agrees with TypeScript for %s', (body, expected) => {
    expect(resolveViaCli(body)).toBe(expected);
    if (hasSpecOnlySignal(body)) {
      expect(extractNonClosingIssueNumber(body)).toBe(expected);
    } else {
      expect(extractClosingIssueNumber(body)).toBe(expected);
    }
  });
});

describe('checkPrScope — spec-only', () => {
  const repoRoot = join(tmpdir(), `scope-guard-spec-${randomUUID()}`);

  it('passes without a declaration snapshot when signal, Refs, and allowlisted paths hold', () => {
    const prBody = [SPEC_SIGNAL, '', 'Refs #121', '', '## Summary', 'Spec-only draft publish.'].join('\n');
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: null,
      prPaths: ['docs/issues_drafts/43-spec-only-scope-guard-docs-prs.md', 'docs/issue_queue_index.md'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: true,
      mode: 'spec-only',
      issueNumber: 121,
    });
  });

  it('fails when spec-only signal is combined with a closing keyword', () => {
    const prBody = [SPEC_SIGNAL, '', 'Closes #121'].join('\n');
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: null,
      prPaths: ['docs/issue_queue_index.md'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'spec_only_with_closing_keyword',
    });
    expect(hasClosingIssueReference(prBody)).toBe(true);
  });

  it('fails when diff touches paths outside the spec-docs allowlist', () => {
    const prBody = [SPEC_SIGNAL, '', 'Refs #121'].join('\n');
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: null,
      prPaths: ['scripts/pr-scope-check.ts'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'spec_docs_scope_violation',
    });
  });

  it('fails without a non-closing issue reference', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: SPEC_SIGNAL,
      issueBody: null,
      prPaths: ['docs/issue_queue_index.md'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_spec_issue_reference',
    });
  });
});

describe('checkPrScope — implementation', () => {
  it('fails without a closing reference', () => {
    const result = checkPrScope({
      repoRoot: join(tmpdir(), `scope-guard-impl-${randomUUID()}`),
      prBody: '## Summary\n\nImplements feature.',
      issueBody: null,
      prPaths: ['scripts/pr-scope-check.ts'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_issue_link',
    });
  });

  it('fails without a committed snapshot', () => {
    const repoRoot = join(tmpdir(), `scope-guard-impl-${randomUUID()}`);
    const result = checkPrScope({
      repoRoot,
      prBody: 'Closes #121',
      issueBody: '```denylist\nvendor/**\n```',
      prPaths: ['scripts/pr-scope-check.ts'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_snapshot',
    });
  });
});

describe('resolveLatestCommittedSnapshot', () => {
  it('does not treat lexicographic filename order as chronological order', () => {
    const repoRoot = join(tmpdir(), `scope-guard-${randomUUID()}`);
    const declarationsDir = join(repoRoot, 'docs', 'declarations');
    mkdirSync(declarationsDir, { recursive: true });

    writeSnapshot(repoRoot, 9, 'op-1', {
      supersedes: null,
      created_at: '2026-05-27T10:00:00.000Z',
    });
    writeSnapshot(repoRoot, 9, 'op-2', {
      supersedes: 'op-1',
      created_at: '2026-05-27T11:00:00.000Z',
    });
    writeSnapshot(repoRoot, 9, 'op-10', {
      supersedes: 'op-2',
      created_at: '2026-05-27T12:00:00.000Z',
    });

    const result = resolveLatestCommittedSnapshot(repoRoot, 9);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.iteration_id).toBe('op-10');
    }
  });
});
