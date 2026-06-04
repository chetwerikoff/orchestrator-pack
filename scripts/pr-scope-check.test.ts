import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyNoCeremonyPaths,
  classifySpecDocsPaths,
  CLOSING_KEYWORD_ALTERNATION,
  extractClosingIssueNumber,
  extractNonClosingIssueNumber,
  findNoCeremonyIssueLinks,
  hasClosingIssueReference,
  hasNoCeremonyIssueLink,
  hasSpecOnlySignal,
  isNoCeremonyPr,
  NON_CLOSING_ISSUE_REF_PATTERN,
  NO_CEREMONY_MARKDOWN_GLOBS,
  SPEC_DOCS_ALLOWLIST,
  SPEC_DOCS_MARKDOWN_GLOBS,
  SPEC_ONLY_SIGNAL_LITERAL,
  SPEC_SKILL_MARKDOWN_GLOBS,
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
  it('detects the canonical spec-only signal on its own line', () => {
    expect(hasSpecOnlySignal(`## Summary\n\n${SPEC_SIGNAL}\n\nRefs #121`)).toBe(true);
    expect(hasSpecOnlySignal('<!-- PR-TYPE: spec-only -->')).toBe(true);
    expect(hasSpecOnlySignal('Spec only PR')).toBe(false);
  });

  it('does not treat inline or prose mentions of the signal as a declaration', () => {
    const proseMention = [
      'Closes #161',
      '',
      '## Summary',
      '',
      '- Passes without the spec-only PR-body signal or `<!-- pr-type: spec-only -->` in the description.',
    ].join('\n');
    expect(hasSpecOnlySignal(proseMention)).toBe(false);
    expect(hasSpecOnlySignal(['```html', SPEC_SIGNAL, '```'].join('\n'))).toBe(false);
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

  it('findNoCeremonyIssueLinks detects closing, Refs, bare hash, and issue URLs', () => {
    expect(findNoCeremonyIssueLinks('Closes #1')).toEqual([1]);
    expect(findNoCeremonyIssueLinks('Refs #2')).toEqual([2]);
    expect(findNoCeremonyIssueLinks('(see #3)')).toEqual([3]);
    expect(
      findNoCeremonyIssueLinks('https://github.com/org/repo/issues/4#issuecomment-1'),
    ).toEqual([4]);
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

  it('passes without a declaration snapshot when signal, Refs, allowlisted paths, and issue body hold', () => {
    const prBody = [SPEC_SIGNAL, '', 'Refs #121', '', '## Summary', 'Spec-only draft publish.'].join('\n');
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: 'GitHub Issue: #121\n\n```denylist\nvendor/**\n```',
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

  it('fails when the referenced issue body could not be read', () => {
    const prBody = [SPEC_SIGNAL, '', 'Refs #999999'].join('\n');
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
      reason: 'issue_unreadable',
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
      issueBody: 'GitHub Issue: #121',
      prPaths: ['scripts/pr-scope-check.ts'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'spec_docs_scope_violation',
    });
  });

  it('signalled spec-only takes precedence over no-ceremony when mixed with docs paths', () => {
    const prBody = [SPEC_SIGNAL, '', 'Refs #159', '', '## Summary', 'Spec draft + skill.'].join('\n');
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: 'GitHub Issue: #159\n\n```denylist\nvendor/**\n```',
      prPaths: [
        'docs/issue_queue_index.md',
        '.claude/skills/create-issue-draft/SKILL.md',
      ],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: true,
      mode: 'spec-only',
      issueNumber: 159,
    });
  });

  it('fails when spec-only skill markdown is mixed with an out-of-allowlist path', () => {
    const prBody = [SPEC_SIGNAL, '', 'Refs #159'].join('\n');
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: 'GitHub Issue: #159',
      prPaths: ['.claude/skills/create-issue-draft/SKILL.md', 'scripts/pr-scope-check.ts'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'spec_docs_scope_violation',
    });
  });

  it('fails when a non-markdown file under a skill directory is in the diff', () => {
    const prBody = [SPEC_SIGNAL, '', 'Refs #159'].join('\n');
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: 'GitHub Issue: #159',
      prPaths: ['.claude/skills/create-issue-draft/run.sh'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'spec_docs_scope_violation',
    });
  });

  it('fails without a non-closing issue reference when paths are outside no-ceremony', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: SPEC_SIGNAL,
      issueBody: null,
      prPaths: ['docs/issues_drafts/foo.json'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_spec_issue_reference',
    });
  });
});

describe('checkPrScope — no-ceremony', () => {
  const repoRoot = join(tmpdir(), `scope-guard-no-ceremony-${randomUUID()}`);

  const skillPaths = [
    '.claude/skills/create-issue-draft/SKILL.md',
    '.cursor/skills/create-issue-draft/SKILL.md',
  ];

  it('passes with no snapshot, issue reference, or spec-only signal', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: '## Summary\n\nSkill instruction edit only.',
      issueBody: null,
      prPaths: skillPaths,
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: true,
      mode: 'no-ceremony',
    });
    expect('issueNumber' in result && result.ok && result.issueNumber).toBeFalsy();
  });

  it('passes for spec-docs markdown only with no ceremony', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: '## Summary\n\nDraft spec edit only.',
      issueBody: null,
      prPaths: ['docs/issues_drafts/59-spec-docs-only-pr-no-ceremony.md'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({ ok: true, mode: 'no-ceremony' });
  });

  it.each([
    ['Closes #999', 999],
    ['Refs #123', 123],
    ['Tracks work for #456 in the skill text.', 456],
    [
      'See https://github.com/chetwerikoff/orchestrator-pack/issues/789 for context.',
      789,
    ],
  ])('fails when the body links an issue (%s)', (fragment, issueNumber) => {
    const prBody = `${fragment}\n\n## Summary\n\nSkill tweak.`;
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: null,
      prPaths: skillPaths,
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'skill_doc_with_issue_reference',
    });
    expect(hasNoCeremonyIssueLink(prBody)).toBe(true);
    expect(findNoCeremonyIssueLinks(prBody)).toContain(issueNumber);
  });

  it('does not treat issue mentions inside fenced code as links', () => {
    const prBody = ['## Summary', '', '```', 'Refs #123', '```'].join('\n');
    expect(hasNoCeremonyIssueLink(prBody)).toBe(false);
    const result = checkPrScope({
      repoRoot,
      prBody,
      issueBody: null,
      prPaths: skillPaths,
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({ ok: true, mode: 'no-ceremony' });
  });

  it('passes without spec-only signal when the body has no issue reference', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: SPEC_ONLY_SIGNAL_LITERAL,
      issueBody: null,
      prPaths: skillPaths,
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({ ok: true, mode: 'no-ceremony' });
  });

  it('does not qualify when a non-markdown file is under a skill directory', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: '## Summary',
      issueBody: null,
      prPaths: ['.claude/skills/foo/run.sh'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_issue_link',
    });
  });

  it('passes when skill markdown is mixed with spec-docs markdown', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: '## Summary\n\nSkill and draft edits.',
      issueBody: null,
      prPaths: ['.claude/skills/foo/SKILL.md', 'docs/issue_queue_index.md'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({ ok: true, mode: 'no-ceremony' });
    expect(isNoCeremonyPr(['.claude/skills/foo/SKILL.md', 'docs/issue_queue_index.md'])).toBe(
      true,
    );
  });

  it('does not qualify when a markdown path is outside the union (e.g. README.md)', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: '## Summary',
      issueBody: null,
      prPaths: ['docs/issues_drafts/foo.md', 'README.md'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_issue_link' });
  });

  it('does not qualify when skill markdown is mixed with code', () => {
    const result = checkPrScope({
      repoRoot,
      prBody: 'Closes #121',
      issueBody: null,
      prPaths: ['.claude/skills/foo/SKILL.md', 'scripts/pr-scope-check.ts'],
      degradedMode: false,
      forkPr: false,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'missing_snapshot',
    });
  });
});

describe('classifyNoCeremonyPaths — union boundary', () => {
  it('accepts markdown under skill surfaces', () => {
    expect(classifyNoCeremonyPaths(['.claude/skills/foo/SKILL.md'])).toMatchObject({ ok: true });
    expect(isNoCeremonyPr(['.claude/skills/foo/SKILL.md', '.cursor/skills/foo/SKILL.md'])).toBe(
      true,
    );
  });

  it('accepts spec-docs markdown paths', () => {
    expect(
      classifyNoCeremonyPaths(['docs/issues_drafts/59-spec-docs-only-pr-no-ceremony.md']),
    ).toMatchObject({ ok: true });
    expect(isNoCeremonyPr(['docs/architecture.md', 'docs/issue_queue_index.md'])).toBe(true);
  });

  it('rejects non-markdown under skill directories', () => {
    const result = classifyNoCeremonyPaths(['.claude/skills/foo/helper.sh']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outOfNoCeremonyMarkdown).toContain('.claude/skills/foo/helper.sh');
    }
  });

  it('rejects non-markdown under docs/issues_drafts', () => {
    const result = classifyNoCeremonyPaths(['docs/issues_drafts/foo.json']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outOfNoCeremonyMarkdown).toContain('docs/issues_drafts/foo.json');
    }
  });

  it('rejects empty path lists', () => {
    expect(isNoCeremonyPr([])).toBe(false);
  });
});

describe('no-ceremony PR — pointer drift remains an independent gate', () => {
  it('fails drift check when a pointer does not match canonical', () => {
    const repoRoot = join(tmpdir(), `skill-drift-${randomUUID()}`);
    const scriptsDir = join(repoRoot, 'scripts');
    const canonicalDir = join(repoRoot, '.claude/skills/drift-fixture');
    const pointerDir = join(repoRoot, '.cursor/skills/drift-fixture');
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(pointerDir, { recursive: true });

    writeFileSync(
      join(scriptsDir, 'skill-pointer-targets.json'),
      readFileSync(join('scripts', 'skill-pointer-targets.json'), 'utf8'),
      'utf8',
    );

    const canonicalBody = [
      '---',
      'name: drift-fixture',
      'description: fixture for drift test',
      '---',
      '',
      '# Drift fixture',
    ].join('\n');
    writeFileSync(join(canonicalDir, 'SKILL.md'), canonicalBody, 'utf8');
    writeFileSync(join(pointerDir, 'SKILL.md'), `${canonicalBody}\nstale edit`, 'utf8');

    const driftScript = join(process.cwd(), 'scripts', 'check-skill-pointer-drift.ps1');
    let driftFailed = false;
    try {
      execFileSync('pwsh', ['-NoProfile', '-File', driftScript, '-RepoRoot', repoRoot], {
        encoding: 'utf8',
      });
    } catch {
      driftFailed = true;
    }
    expect(driftFailed).toBe(true);

    const scopeResult = checkPrScope({
      repoRoot,
      prBody: '## Summary\n\nSkill only.',
      issueBody: null,
      prPaths: [
        '.claude/skills/drift-fixture/SKILL.md',
        '.cursor/skills/drift-fixture/SKILL.md',
      ],
      degradedMode: false,
      forkPr: false,
    });
    expect(scopeResult).toMatchObject({ ok: true, mode: 'no-ceremony' });
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

describe('classifySpecDocsPaths — skill markdown boundary', () => {
  it('accepts markdown under canonical and pointer skill surfaces', () => {
    const result = classifySpecDocsPaths([
      '.claude/skills/foo/SKILL.md',
      '.cursor/skills/foo/SKILL.md',
    ]);
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects non-markdown files under skill directories', () => {
    const result = classifySpecDocsPaths(['.claude/skills/foo/helper.sh']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.outOfAllowlist).toContain('.claude/skills/foo/helper.sh');
    }
  });
});

describe('repository_policy.md documents the runtime spec-docs allowlist', () => {
  it('lists every SPEC_DOCS_ALLOWLIST pattern (or skill markdown boundary prose)', () => {
    const policy = readFileSync(join('docs', 'repository_policy.md'), 'utf8');
    for (const pattern of SPEC_DOCS_ALLOWLIST) {
      if (pattern.endsWith('/**/*.md')) {
        expect(policy).toContain('markdown only');
        expect(policy).toContain(pattern.replace('/**/*.md', ''));
        continue;
      }
      expect(policy).toContain(`\`${pattern}\``);
    }
  });

  it('documents the no-ceremony PR shape and union trigger globs', () => {
    const policy = readFileSync(join('docs', 'repository_policy.md'), 'utf8');
    expect(policy).toMatch(/no-ceremony/i);
    expect(policy).toContain('diff-content');
    for (const pattern of NO_CEREMONY_MARKDOWN_GLOBS) {
      expect(policy).toContain(pattern);
    }
    for (const pattern of SPEC_DOCS_MARKDOWN_GLOBS) {
      expect(policy).toContain(pattern);
    }
    for (const pattern of SPEC_SKILL_MARKDOWN_GLOBS) {
      expect(policy).toContain(pattern);
    }
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
