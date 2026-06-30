import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSanctionedGhIssueMutation,
  bodiesMatchForParity,
  buildMutationAuditRecord,
  buildRestIssueBodyPath,
  buildSanctionedMutationArgv,
  classifyMismatch,
  compareIssueBodies,
  extractExpectedIssueBodyFromDraft,
  formatParityFailureMessage,
  isLiteralTempPathBody,
  parseCreatedIssueNumber,
  syncPublishIssueBody,
  type GhInvocationResult,
  type MutationAuditRecord,
} from './lib/publish-issue-body-sync.js';

const SAMPLE_DRAFT = `# Sample draft title

GitHub Issue: TBD

## Goal

Do the thing.
`;

const EXPECTED_BODY = `GitHub Issue: TBD

## Goal

Do the thing.
`;

function makeDeps(overrides: {
  mutationResult?: GhInvocationResult;
  liveBody?: string;
  liveReadResult?: GhInvocationResult;
  onRunGh?: (argv: string[]) => GhInvocationResult;
} = {}) {
  const audits: MutationAuditRecord[] = [];
  const mutationCalls: string[][] = [];
  const liveReadCalls: string[][] = [];

  const deps = {
    runGh(argv: string[]) {
      mutationCalls.push(argv);
      if (overrides.onRunGh) {
        return overrides.onRunGh(argv);
      }
      if (argv[1] === 'api') {
        liveReadCalls.push(argv);
        return overrides.liveReadResult ?? {
          exitCode: 0,
          stdout: overrides.liveBody ?? EXPECTED_BODY,
          stderr: '',
        };
      }
      return overrides.mutationResult ?? {
        exitCode: 0,
        stdout: 'https://github.com/chetwerikoff/orchestrator-pack/issues/542\n',
        stderr: '',
      };
    },
    writeBodyFile(content: string) {
      return `/tmp/issue-body-${content.length}.md`;
    },
    emitAudit(record: MutationAuditRecord) {
      audits.push(record);
    },
  };

  return { deps, audits, mutationCalls, liveReadCalls };
}

describe('publish issue-body sync (#542)', () => {
  it('extracts expected issue body as draft minus H1 and following blank line', () => {
    expect(extractExpectedIssueBodyFromDraft(SAMPLE_DRAFT)).toBe(EXPECTED_BODY);
  });

  it('sanctioned mutation path only: rejects low-level gh api issue-body mutation', () => {
    expect(() =>
      assertSanctionedGhIssueMutation([
        'gh',
        'api',
        'repos/o/r/issues/1',
        '--field',
        'body=@/tmp/tmp.IoxWVuqfWY',
      ]),
    ).toThrow(/unsanctioned low-level gh api issue-body mutation/);
  });

  it('sanctioned mutation path only: rejects inline --body mutations', () => {
    expect(() =>
      assertSanctionedGhIssueMutation(['gh', 'issue', 'edit', '1', '--repo', 'o/r', '--body', 'x']),
    ).toThrow(/inline --body/);
  });

  it('sanctioned mutation path only: requires gh issue create/edit with --body-file', () => {
    const argv = buildSanctionedMutationArgv({
      mode: 'edit',
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 542,
      bodyFilePath: '/tmp/issue-body.md',
    });
    expect(argv).toEqual([
      'gh',
      'issue',
      'edit',
      '--repo',
      'chetwerikoff/orchestrator-pack',
      '--body-file',
      '/tmp/issue-body.md',
      '542',
    ]);
    expect(() => assertSanctionedGhIssueMutation(argv)).not.toThrow();
  });

  it('REST parity gate: fails closed when mutation succeeds but live REST body mismatches', () => {
    const { deps } = makeDeps({ liveBody: '@/tmp/tmp.IoxWVuqfWY' });
    const result = syncPublishIssueBody(deps, {
      mode: 'edit',
      draftPath: 'docs/issues_drafts/sample.md',
      draftContent: SAMPLE_DRAFT,
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 538,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatchClass).toBe('literal-temp-path');
      expect(result.message).toContain('issue #538');
      expect(result.message).toContain('literal-temp-path');
    }
  });

  it('literal-temp-path regression: detects @/tmp/... live bodies', () => {
    expect(isLiteralTempPathBody('@/tmp/tmp.IoxWVuqfWY')).toBe(true);
    expect(classifyMismatch(EXPECTED_BODY, '@/tmp/tmp.IoxWVuqfWY')).toBe('literal-temp-path');
    expect(
      formatParityFailureMessage({
        issueNumber: 538,
        mismatchClass: 'literal-temp-path',
        repo: 'chetwerikoff/orchestrator-pack',
      }),
    ).toContain('issue #538');
  });

  it('positive outcome: reports success only after live REST body parity holds', () => {
    const { deps, audits } = makeDeps({ liveBody: EXPECTED_BODY });
    const result = syncPublishIssueBody(deps, {
      mode: 'edit',
      draftPath: 'docs/issues_drafts/sample.md',
      draftContent: SAMPLE_DRAFT,
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 542,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issueNumber).toBe(542);
    }
    expect(audits[0]?.argvClass).toBe('gh-issue-edit-body-file');
    expect(audits[0]?.bodySource).toBe('body-file');
    expect(audits[0]?.bodyFilePath).toMatch(/issue-body-/);
  });

  it('mutation audit trail records subcommand/argv class without logging full body', () => {
    const audit = buildMutationAuditRecord({
      mode: 'create',
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 542,
      bodyFilePath: '/tmp/issue-body.md',
    });
    expect(audit).toEqual({
      subcommand: 'issue create',
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 542,
      bodySource: 'body-file',
      bodyFilePath: '/tmp/issue-body.md',
      argvClass: 'gh-issue-create-body-file',
    });
    expect(JSON.stringify(audit)).not.toContain('## Goal');
  });

  it('sync-only verify mode uses the same REST parity gate without mutation', () => {
    const { deps, mutationCalls } = makeDeps({ liveBody: EXPECTED_BODY });
    const result = syncPublishIssueBody(deps, {
      mode: 'verify',
      draftPath: 'docs/issues_drafts/sample.md',
      draftContent: SAMPLE_DRAFT,
      repo: 'chetwerikoff/orchestrator-pack',
      issueNumber: 542,
    });

    expect(result.ok).toBe(true);
    expect(mutationCalls.filter((argv) => argv[2] === 'create' || argv[2] === 'edit')).toEqual([]);
  });

  it('delegated create path uses sanctioned mutation then parity gate', () => {
    const { deps, mutationCalls, liveReadCalls } = makeDeps({
      liveBody: EXPECTED_BODY,
      mutationResult: {
        exitCode: 0,
        stdout: 'https://github.com/chetwerikoff/orchestrator-pack/issues/777\n',
        stderr: '',
      },
    });

    const result = syncPublishIssueBody(deps, {
      mode: 'create',
      draftPath: 'docs/issues_drafts/sample.md',
      draftContent: SAMPLE_DRAFT,
      repo: 'chetwerikoff/orchestrator-pack',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issueNumber).toBe(777);
    }
    expect(mutationCalls[0]?.slice(0, 5)).toEqual(['gh', 'issue', 'create', '--repo', 'chetwerikoff/orchestrator-pack']);
    expect(mutationCalls[0]).toContain('--body-file');
    expect(liveReadCalls[0]?.[2]).toBe(buildRestIssueBodyPath('chetwerikoff/orchestrator-pack', 777));
    expect(parseCreatedIssueNumber('https://github.com/chetwerikoff/orchestrator-pack/issues/777')).toBe(777);
  });

  it('no newline-only false failure at the permitted normalization boundary', () => {
    expect(bodiesMatchForParity('alpha\nbeta', 'alpha\nbeta\n')).toBe(true);
    expect(compareIssueBodies('alpha\nbeta', 'alpha\nbeta\n').match).toBe(true);
    expect(compareIssueBodies('alpha\nbeta\n', 'alpha\nbeta').match).toBe(true);
    expect(compareIssueBodies('alpha\nbeta', 'alpha\nbeta\n\n').match).toBe(false);
    expect(compareIssueBodies('alpha\nbeta', 'alphaX\nbeta').match).toBe(false);
  });

  it('worktree-isolation composition preserved: opencode publish helper still isolates scratch checkout', () => {
    const helper = readFileSync('.claude/skills/publish-issue-draft/opencode-publish.sh', 'utf8');
    expect(helper).toContain('prepare_scratch_checkout');
    expect(helper).toContain('PUB_SCRATCH');
    expect(helper).toContain('copy_publish_inputs');
    expect(helper).not.toContain('git checkout main');
  });

  it('publish skill surfaces route issue-body sync through the mechanical helper', () => {
    for (const skillPath of [
      '.claude/skills/publish-issue-draft/SKILL.md',
      '.claude/skills/create-issue-draft/SKILL.md',
    ]) {
      const text = readFileSync(skillPath, 'utf8');
      expect(text).toContain('publish-issue-body-sync');
      expect(text).not.toMatch(/gh issue (create|edit)[^\n]*--body(?!-file)/);
      expect(text).not.toMatch(/gh api[^\n]*\/issues[^\n]*body=/);
    }
  });
});
