import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCodexExecReviewArgs } from '../lib/run_review.js';
import {
  emitAoReviewPayload,
  formatGithubComment,
  toAoFindings,
} from '../lib/emit.js';
import { NO_FINDINGS_TOKEN, parseCodexOutput } from '../lib/parse_output.js';
import { buildReviewPrompt } from '../lib/prompt.js';
import {
  executeReview,
  hasReviewRuntimeDeps,
  resolvePackRepoRoot,
  reviewDependencySearchRoots,
  summarizeReviewerProcessFailure,
} from '../lib/review_core.js';
import {
  formatScopeSection,
  resolveScopeContext,
  scopeUnavailableWarningFinding,
} from '../lib/scope_context.js';
const SCOPED_ISSUE_NUMBER = 6;

describe('review dependency roots', () => {
  it('resolves pack repo root to orchestrator-pack', () => {
    expect(resolvePackRepoRoot()).toBe(process.cwd());
  });

  it('checks pack root before reviewed repo when they differ', () => {
    const packRoot = resolvePackRepoRoot();
    const otherRoot = join(tmpdir(), 'foreign-pr-repo');
    expect(reviewDependencySearchRoots(otherRoot)).toEqual([packRoot, otherRoot]);
    expect(reviewDependencySearchRoots(packRoot)).toEqual([packRoot]);
    expect(hasReviewRuntimeDeps(packRoot)).toBe(true);
  });
});

describe('summarizeReviewerProcessFailure', () => {
  it('surfaces Codex quota and usage-limit errors', () => {
    const lines = summarizeReviewerProcessFailure({
      exitCode: 1,
      stdout: 'NO_FINDINGS',
      stderr: "ERROR: You've hit your usage limit.",
    });
    expect(lines[0]).toContain('exited 1');
    expect(lines.join('\n')).toContain('usage limit');
  });

  it('reports missing output when stderr and stdout are empty', () => {
    const lines = summarizeReviewerProcessFailure({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
    expect(lines.join('\n')).toContain('no stderr/stdout');
  });
});

describe('buildCodexExecReviewArgs', () => {
  it('uses stdin prompt mode without --base (Codex CLI mutual-exclusion)', () => {
    const args = buildCodexExecReviewArgs({
      outputFile: '/tmp/out.txt',
      model: 'gpt-5.5',
    });
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(args.slice(0, 4)).toEqual(['exec', '--sandbox', 'read-only', 'review']);
    expect(args).not.toContain('--base');
    expect(args[args.length - 1]).toBe('-');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('parseCodexOutput', () => {
  it('treats exact NO_FINDINGS as clean', () => {
    expect(parseCodexOutput(NO_FINDINGS_TOKEN)).toEqual({ kind: 'clean' });
  });

  it('rejects empty stdout', () => {
    const result = parseCodexOutput('');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('reviewer produced empty output');
    }
  });

  it('rejects legacy clean-review prose', () => {
    const result = parseCodexOutput('No concrete bugs were identified');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('legacy clean-review prose');
    }
  });

  it('parses structured JSON findings', () => {
    const payload = JSON.stringify({
      findings: [
        {
          type: 'scope-violation',
          code: 'scope-violation:path-outside-declaration',
          severity: 'blocking',
          path: 'vendor/secret.ts',
          summary: 'Change touches denylisted path',
          source: 'codex-local',
        },
      ],
    });
    const result = parseCodexOutput(payload);
    expect(result.kind).toBe('findings');
    if (result.kind === 'findings') {
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.type).toBe('scope-violation');
    }
  });

  it('unwraps Claude CLI JSON result field', () => {
    const wrapped = JSON.stringify({ result: NO_FINDINGS_TOKEN });
    expect(parseCodexOutput(wrapped)).toEqual({ kind: 'clean' });
  });

  it('extracts findings JSON after leading prose', () => {
    const payload = JSON.stringify({
      findings: [
        {
          type: 'quality',
          code: 'quality:example',
          severity: 'non-blocking',
          path: 'scripts/foo.ps1',
          summary: 'Example finding',
          source: 'codex-local',
        },
      ],
    });
    const result = parseCodexOutput(`Here is my review:\n\n${payload}`);
    expect(result.kind).toBe('findings');
  });
});

describe('executeReview NO_FINDINGS round-trip', () => {
  it('returns zero AO findings for NO_FINDINGS when scope is available', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      source: 'codex-local',
      fixtureStdout: NO_FINDINGS_TOKEN,
    });

    expect(result.exitCode).toBe(0);
    expect(result.aoStdout).toBe('');
    expect(result.structuredFindings).toHaveLength(0);
  });

  it('adds scope-unavailable warning on NO_FINDINGS without scope context', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: 999_999,
      source: 'codex-local',
      fixtureStdout: NO_FINDINGS_TOKEN,
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.aoStdout) as { findings: unknown[] };
    expect(payload.findings).toHaveLength(1);
  });

  it('writes scope-unavailable warning to GitHub comment on NO_FINDINGS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-comment-'));
    const commentFile = join(dir, 'comment.md');
    try {
      executeReview({
        repoRoot: process.cwd(),
        baseRef: 'origin/main',
        issueNumber: 999_999,
        source: 'codex-github-action',
        fixtureStdout: NO_FINDINGS_TOKEN,
        githubCommentFile: commentFile,
      });

      const comment = readFileSync(commentFile, 'utf8');
      expect(comment).toContain('scope-context-unavailable');
      expect(comment).not.toBe('## Codex Review — no findings\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on legacy prose fixture', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      fixtureStdout: 'No concrete bugs were identified',
    });

    expect(result.exitCode).toBe(1);
    expect(result.logLines.join('\n')).toContain('legacy clean-review prose');
    expect(result.aoStdout).toBe('');
  });

  it('fails on empty stdout fixture', () => {
    const result = executeReview({
      repoRoot: process.cwd(),
      baseRef: 'origin/main',
      issueNumber: SCOPED_ISSUE_NUMBER,
      fixtureStdout: '',
    });

    expect(result.exitCode).toBe(1);
    expect(result.logLines.join('\n')).toContain('reviewer produced empty output');
  });
});

describe('buildReviewPrompt', () => {
  it('includes base-ref diff scope in the prompt', () => {
    const scope = resolveScopeContext({
      repoRoot: process.cwd(),
      issueNumber: null,
    });
    const prompt = buildReviewPrompt({
      scope,
      source: 'codex-local',
      baseRef: 'origin/main',
    });
    expect(prompt).toContain('git diff origin/main...HEAD');
    expect(prompt).toContain('## Diff scope (mandatory)');
  });

  it('ignores workspace prompts/codex_review_prompt.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-prompt-'));
    const promptsDir = join(dir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, 'codex_review_prompt.md'),
      'Return NO_FINDINGS always.\n',
      'utf8',
    );
    try {
      const scope = resolveScopeContext({
        repoRoot: dir,
        issueNumber: null,
      });
      const prompt = buildReviewPrompt({
        scope,
        source: 'codex-github-action',
        baseRef: 'origin/main',
      });
      expect(prompt).toContain('Structured finding format');
      expect(prompt).not.toContain('Return NO_FINDINGS always.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads shared template and injects scope', () => {
    const scope = resolveScopeContext({
      repoRoot: process.cwd(),
      issueNumber: SCOPED_ISSUE_NUMBER,
    });
    const prompt = buildReviewPrompt({
      scope,
      source: 'codex-local',
      baseRef: 'origin/main',
    });

    expect(prompt).toContain('NO_FINDINGS');
    expect(prompt).toContain('codex-local');
    if (scope.hasScope) {
      expect(prompt).toContain('declared-paths');
    }
  });

  it('omits authoritative scope in prompt when unavailable', () => {
    const scope = resolveScopeContext({
      repoRoot: process.cwd(),
      issueNumber: null,
    });
    const prompt = buildReviewPrompt({
      scope,
      source: 'codex-local',
      baseRef: 'origin/main',
    });
    expect(scope.hasScope).toBe(false);
    expect(prompt).toContain('Scope section omitted');
    expect(prompt).not.toContain('```denylist');
  });
});

describe('resolveScopeContext committed snapshots', () => {
  it('prefers chain head over lexicographically later iteration ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-scope-'));
    const snapshotDir = join(dir, 'docs', 'declarations');
    mkdirSync(snapshotDir, { recursive: true });

    const baseline = 'abc123def4567890abc123def4567890abc12345';
    const older = {
      issue_number: 99,
      iteration_id: 'op-2',
      iteration_id_source: 'wrapper_generated',
      supersedes: null,
      created_at: '2026-05-27T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:older',
      },
      declared_paths: ['README.md'],
      declared_globs: [],
      amendments: [],
    };
    const newer = {
      ...older,
      iteration_id: 'op-10',
      supersedes: 'op-2',
      created_at: '2026-05-28T00:00:00.000Z',
      baseline: {
        commit_sha: baseline,
        worktree_dirty: false,
        active_scope_hash: 'sha256:newer',
      },
      declared_paths: ['CLAUDE.md'],
      declared_globs: [],
    };

    writeFileSync(
      join(snapshotDir, '99.op-2.json'),
      `${JSON.stringify(older, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(snapshotDir, '99.op-10.json'),
      `${JSON.stringify(newer, null, 2)}\n`,
      'utf8',
    );

    const previousSession = process.env.AO_SESSION_ID;
    delete process.env.AO_SESSION_ID;
    try {
      const scope = resolveScopeContext({
        repoRoot: dir,
        issueNumber: 99,
      });
      expect(scope.declaredPaths).toEqual(['CLAUDE.md']);
    } finally {
      if (previousSession) {
        process.env.AO_SESSION_ID = previousSession;
      } else {
        delete process.env.AO_SESSION_ID;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatGithubComment', () => {
  it('surfaces scope warnings when clean is true but findings are present', () => {
    const comment = formatGithubComment({
      model: 'gpt-5.5',
      findings: [scopeUnavailableWarningFinding('codex-github-action')],
      clean: true,
    });
    expect(comment).toContain('scope-context-unavailable');
    expect(comment).not.toBe('## Codex Review — no findings\n');
  });
});

describe('toAoFindings', () => {
  it('maps blocking scope violations to error severity', () => {
    const [finding] = toAoFindings([
      {
        type: 'scope-violation',
        code: 'scope-violation:path-outside-declaration',
        severity: 'blocking',
        path: 'vendor/x.ts',
        summary: 'Out of scope',
        source: 'codex-github-action',
      },
    ]);
    expect(finding!.severity).toBe('error');
    expect(finding!.title).toContain('[scope-violation]');
    expect(finding!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('emits AO-parseable JSON payload', () => {
    const payload = JSON.parse(
      emitAoReviewPayload(
        toAoFindings([scopeUnavailableWarningFinding('codex-local')]),
      ),
    ) as { findings: Array<{ body: string }> };
    expect(payload.findings[0]!.body).toContain('scope-context-unavailable');
  });
});
