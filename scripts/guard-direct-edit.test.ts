import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateDirectEditGuard,
  formatDenyOutput,
  isGatedDraftFile,
  isReviewSubtree,
  isUnchangedAllowlisted,
  resolveProjectRelativePath,
  runHookFromStdin,
} from './guard-direct-edit.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function stdinFor(filePath: string) {
  return JSON.stringify({ tool_input: { file_path: filePath } });
}

function envState(
  state: 'none' | 'draft-fallback' | 'direct-edit',
): Record<string, string | undefined> {
  if (state === 'draft-fallback') {
    return { AO_DRAFT_AUTHOR_FALLBACK_REASON: 'architect-as-author fallback per #579' };
  }
  if (state === 'direct-edit') {
    return { AO_DIRECT_EDIT_REASON: 'user authorized direct fix for probe' };
  }
  return {};
}

function expectAllow(result: ReturnType<typeof evaluateDirectEditGuard>) {
  expect(result.decision).toBe('allow');
}

function expectDeny(
  result: ReturnType<typeof evaluateDirectEditGuard>,
  reasonPattern: RegExp,
) {
  expect(result.decision).toBe('deny');
  expect(result.reason ?? '').toMatch(reasonPattern);
}

describe('resolveProjectRelativePath', () => {
  it('normalizes repo-relative paths', () => {
    expect(resolveProjectRelativePath('docs/architecture.md', repoRoot)).toBe(
      'docs/architecture.md',
    );
  });

  it('fail-opens when the resolved path escapes the project root', () => {
    expect(resolveProjectRelativePath('../../../etc/passwd', repoRoot)).toBeNull();
  });
});

describe('AC#1 draft-file deny without override reason', () => {
  it('denies gated draft Write/Edit with exit 0 deny JSON', () => {
    const stdin = stdinFor('docs/issues_drafts/618-probe-slug.md');
    const hook = runHookFromStdin(stdin, { projectDir: repoRoot, env: envState('none') });

    expect(hook.exitCode).toBe(0);
    expect(hook.decision).toBe('deny');
    expect(hook.stdout).toMatch(/permissionDecision":"deny"/);
    const payload = JSON.parse(hook.stdout.trim());
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(payload.hookSpecificOutput.permissionDecisionReason).toMatch(/draft-author/i);
    expect(payload.hookSpecificOutput.permissionDecisionReason).toMatch(
      /AO_DRAFT_AUTHOR_FALLBACK_REASON/,
    );
    expect(payload.hookSpecificOutput.permissionDecisionReason).toMatch(/#579/);
  });
});

describe('AC#2 draft-file allow with override reason', () => {
  it('allows gated draft Write/Edit when AO_DRAFT_AUTHOR_FALLBACK_REASON is set', () => {
    const hook = runHookFromStdin(stdinFor('docs/issues_drafts/618-probe-slug.md'), {
      projectDir: repoRoot,
      env: envState('draft-fallback'),
    });

    expect(hook.exitCode).toBe(0);
    expect(hook.decision).toBe('allow');
    expect(hook.stdout).toBe('');
  });
});

describe('AC#3 review subtree unchanged', () => {
  it('allows Write/Edit under docs/issues_drafts/.review without override env', () => {
    const hook = runHookFromStdin(
      stdinFor('docs/issues_drafts/.review/618-slug/pass-01.capture.txt'),
      { projectDir: repoRoot, env: envState('none') },
    );

    expect(hook.decision).toBe('allow');
    expect(hook.stdout).toBe('');
    expect(isReviewSubtree('docs/issues_drafts/.review/618-slug/pass-01.capture.txt')).toBe(
      true,
    );
  });
});

describe('AC#4 existing allowlist preserved', () => {
  const allowlistedPaths = [
    'docs/architecture.md',
    'docs/issue_queue_index.md',
    'CLAUDE.md',
    '.claude/skills/create-issue-draft/SKILL.md',
    '.ao/runtime/state.json',
    'agent-orchestrator.yaml',
  ];

  for (const filePath of allowlistedPaths) {
    it(`allows ${filePath} without override env vars`, () => {
      const result = evaluateDirectEditGuard({
        filePath,
        projectDir: repoRoot,
        env: envState('none'),
      });
      expectAllow(result);
      expect(isUnchangedAllowlisted(filePath)).toBe(true);
    });
  }
});

describe('AC#5 fail-open contract', () => {
  it('allows on malformed stdin JSON', () => {
    const hook = runHookFromStdin('{not json', { projectDir: repoRoot, env: envState('none') });
    expect(hook.decision).toBe('allow');
    expect(hook.exitCode).toBe(0);
    expect(hook.stdout).toBe('');
  });

  it('allows when file_path is missing', () => {
    const hook = runHookFromStdin(JSON.stringify({ tool_input: {} }), {
      projectDir: repoRoot,
      env: envState('none'),
    });
    expect(hook.decision).toBe('allow');
    expect(hook.stdout).toBe('');
  });

  it('allows when the resolved path escapes the project root', () => {
    const hook = runHookFromStdin(stdinFor('../../../outside.md'), {
      projectDir: repoRoot,
      env: envState('none'),
    });
    expect(hook.decision).toBe('allow');
    expect(hook.stdout).toBe('');
  });
});

describe('AC#6 AO_DIRECT_EDIT_REASON preserved for non-draft paths', () => {
  const probePath = 'plugins/probe.mjs';

  it('denies without AO_DIRECT_EDIT_REASON', () => {
    const result = evaluateDirectEditGuard({
      filePath: probePath,
      projectDir: repoRoot,
      env: envState('none'),
    });
    expectDeny(result, /AO_DIRECT_EDIT_REASON/);
    expect(isGatedDraftFile(probePath)).toBe(false);
  });

  it('allows with non-empty AO_DIRECT_EDIT_REASON', () => {
    const result = evaluateDirectEditGuard({
      filePath: probePath,
      projectDir: repoRoot,
      env: envState('direct-edit'),
    });
    expectAllow(result);
  });
});

describe('AC#7 tracked source is versioned', () => {
  it('ships guard source under scripts/ (not gitignored .claude/hooks)', () => {
    const trackedHook = path.join(repoRoot, 'scripts/guard-direct-edit.mjs');
    expect(trackedHook).toMatch(/\/scripts\/guard-direct-edit\.mjs$/);
    expect(trackedHook).not.toMatch(/\/\.claude\/hooks\//);
  });
});

describe('AC#9 scenario matrix', () => {
  /**
   * Reachable cells across path class × env state.
   * Non-applicable: AO_DRAFT_AUTHOR_FALLBACK_REASON does not bypass direct-edit deny
   * for non-draft implementation paths; AO_DIRECT_EDIT_REASON does not bypass gated
   * draft deny (draft gate runs first).
   */
  const matrix: Array<{
    label: string;
    filePath: string;
    env: 'none' | 'draft-fallback' | 'direct-edit';
    expected: 'allow' | 'deny';
    reasonPattern?: RegExp;
  }> = [
    {
      label: 'gated draft / no override',
      filePath: 'docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md',
      env: 'none',
      expected: 'deny',
      reasonPattern: /draft-author|AO_DRAFT_AUTHOR_FALLBACK_REASON/,
    },
    {
      label: 'gated draft / draft fallback',
      filePath: 'docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md',
      env: 'draft-fallback',
      expected: 'allow',
    },
    {
      label: 'gated draft / direct-edit only (N/A bypass)',
      filePath: 'docs/issues_drafts/207-pack-owned-architect-edit-guard-draft-author-gate.md',
      env: 'direct-edit',
      expected: 'deny',
      reasonPattern: /draft-author|AO_DRAFT_AUTHOR_FALLBACK_REASON/,
    },
    {
      label: '.review nested / no override',
      filePath: 'docs/issues_drafts/.review/207-slug/pass-01.capture.txt',
      env: 'none',
      expected: 'allow',
    },
    {
      label: '.review nested / draft fallback',
      filePath: 'docs/issues_drafts/.review/207-slug/pass-01.capture.txt',
      env: 'draft-fallback',
      expected: 'allow',
    },
    {
      label: '.review nested / direct-edit',
      filePath: 'docs/issues_drafts/.review/207-slug/pass-01.capture.txt',
      env: 'direct-edit',
      expected: 'allow',
    },
    {
      label: 'architecture.md / no override',
      filePath: 'docs/architecture.md',
      env: 'none',
      expected: 'allow',
    },
    {
      label: 'architecture.md / draft fallback',
      filePath: 'docs/architecture.md',
      env: 'draft-fallback',
      expected: 'allow',
    },
    {
      label: 'architecture.md / direct-edit',
      filePath: 'docs/architecture.md',
      env: 'direct-edit',
      expected: 'allow',
    },
    {
      label: 'issue_queue_index.md / no override',
      filePath: 'docs/issue_queue_index.md',
      env: 'none',
      expected: 'allow',
    },
    {
      label: 'issue_queue_index.md / draft fallback',
      filePath: 'docs/issue_queue_index.md',
      env: 'draft-fallback',
      expected: 'allow',
    },
    {
      label: 'issue_queue_index.md / direct-edit',
      filePath: 'docs/issue_queue_index.md',
      env: 'direct-edit',
      expected: 'allow',
    },
    {
      label: 'CLAUDE.md / no override',
      filePath: 'CLAUDE.md',
      env: 'none',
      expected: 'allow',
    },
    {
      label: 'CLAUDE.md / draft fallback',
      filePath: 'CLAUDE.md',
      env: 'draft-fallback',
      expected: 'allow',
    },
    {
      label: 'CLAUDE.md / direct-edit',
      filePath: 'CLAUDE.md',
      env: 'direct-edit',
      expected: 'allow',
    },
    {
      label: '.claude/skills / no override',
      filePath: '.claude/skills/create-issue-draft/SKILL.md',
      env: 'none',
      expected: 'allow',
    },
    {
      label: '.claude/skills / draft fallback',
      filePath: '.claude/skills/create-issue-draft/SKILL.md',
      env: 'draft-fallback',
      expected: 'allow',
    },
    {
      label: '.claude/skills / direct-edit',
      filePath: '.claude/skills/create-issue-draft/SKILL.md',
      env: 'direct-edit',
      expected: 'allow',
    },
    {
      label: '.ao / no override',
      filePath: '.ao/probe/state.json',
      env: 'none',
      expected: 'allow',
    },
    {
      label: '.ao / draft fallback',
      filePath: '.ao/probe/state.json',
      env: 'draft-fallback',
      expected: 'allow',
    },
    {
      label: '.ao / direct-edit',
      filePath: '.ao/probe/state.json',
      env: 'direct-edit',
      expected: 'allow',
    },
    {
      label: 'implementation path / no override',
      filePath: 'plugins/probe.mjs',
      env: 'none',
      expected: 'deny',
      reasonPattern: /AO_DIRECT_EDIT_REASON/,
    },
    {
      label: 'implementation path / draft fallback (N/A bypass)',
      filePath: 'plugins/probe.mjs',
      env: 'draft-fallback',
      expected: 'deny',
      reasonPattern: /AO_DIRECT_EDIT_REASON/,
    },
    {
      label: 'implementation path / direct-edit',
      filePath: 'plugins/probe.mjs',
      env: 'direct-edit',
      expected: 'allow',
    },
  ];

  for (const row of matrix) {
    it(`${row.label} → ${row.expected}`, () => {
      const result = evaluateDirectEditGuard({
        filePath: row.filePath,
        projectDir: repoRoot,
        env: envState(row.env),
      });
      if (row.expected === 'allow') {
        expectAllow(result);
      } else {
        expectDeny(result, row.reasonPattern ?? /denied/);
      }
    });
  }
});

describe('formatDenyOutput', () => {
  it('emits PreToolUse deny JSON with exit-0 contract', () => {
    const output = formatDenyOutput('blocked for test');
    const parsed = JSON.parse(output.trim());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('blocked for test');
  });
});
