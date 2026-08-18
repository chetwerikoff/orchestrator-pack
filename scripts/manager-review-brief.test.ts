import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProcessSync } from './kernel/subprocess.ts';
import {
  compareManagerReviewBrief,
  readManagerReviewCanon,
  renderManagerReviewBrief,
  renderManagerReviewBriefBatch,
  type ManagerReviewBriefContext,
} from './lib/manager-review-brief.ts';
import { runStateLightEntry } from './chatgpt-browser-turn/state-light-entry.ts';
import { runCli as runLegacyBrowserTurnCli } from './chatgpt-browser-turn.ts';
import { runBrowserAdapter } from './flow-manager-browser-gpt-long-run.ts';

const roots: string[] = [];
const context: ManagerReviewBriefContext = {
  repositoryFullName: 'example/repo',
  issueNumber: 1431,
  sourceRevision: 'r07',
  stage: 'architectural-review',
  sourceSlot: '01',
  invocationId: '11111111-2222-4333-8444-555555555555',
};

function git(root: string, args: readonly string[]): string {
  const result = runProcessSync({
    command: 'git',
    args,
    cwd: root,
    inheritParentEnv: true,
    timeoutMs: 10_000,
  });
  if (!result.ok) throw new Error(`git fixture failed: ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function commitAll(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
}

function createCanonFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-canon-'));
  roots.push(root);
  mkdirSync(join(root, '.claude/skills/create-issue-draft'), { recursive: true });
  mkdirSync(join(root, '.cursor/rules'), { recursive: true });
  writeFileSync(join(root, '.claude/skills/create-issue-draft/SKILL.md'), [
    '# fixture skill',
    '',
    '```manager-review-brief-canon',
    '.claude/skills/create-issue-draft/SKILL.md :: ### Frame',
    '.cursor/rules/flow-manager-browser-turn-monitoring.mdc :: ## Launch and observation',
    '```',
    '',
    '### Frame',
    'Role: reviewer for <REPOSITORY> issue <ISSUE_NUMBER>.',
    'Stage <STAGE> slot <SLOT> revision <EXPECTED_REVISION>.',
    'INVOCATION_ID_TO_ECHO: <INVOCATION_ID>',
    '',
    '## Other',
    'unselected skill bytes',
    '',
  ].join('\n'));
  writeFileSync(join(root, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc'), [
    '## Launch and observation',
    'Open <ISSUE_URL> and publish the complete review.',
    '',
    '## Other',
    'outside-v1',
    '',
  ].join('\n'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  commitAll(root, 'initial canon');
  return root;
}

function captureWrite(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof stream.write);
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('manager review brief canon', () => {
  it('renders deterministic bound bytes and keeps whole-file blob drift diagnostic-only', () => {
    const root = createCanonFixture();
    const firstSnapshot = readManagerReviewCanon({ repositoryRoot: root });
    const first = renderManagerReviewBrief(firstSnapshot, context);

    expect(first.text).toContain('Role: reviewer for example/repo issue 1431.');
    expect(first.text).toContain('Stage architectural-review slot 01 revision r07.');
    expect(first.text).toContain('INVOCATION_ID_TO_ECHO: 11111111-2222-4333-8444-555555555555');
    expect(first.diagnostics).toHaveLength(2);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(root, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc'), [
      '## Launch and observation',
      'Open <ISSUE_URL> and publish the complete review.',
      '',
      '## Other',
      'outside-v2',
      '',
    ].join('\n'));
    commitAll(root, 'outside selected section only');

    const outsideSnapshot = readManagerReviewCanon({ repositoryRoot: root });
    const outside = renderManagerReviewBrief(outsideSnapshot, context);
    expect(outside.text).toBe(first.text);
    expect(outside.sha256).toBe(first.sha256);
    expect(outside.diagnostics[1]?.blobSha).not.toBe(first.diagnostics[1]?.blobSha);
  });

  it('freezes a plural batch on one snapshot and fresh admission rejects later selected-section drift', () => {
    const root = createCanonFixture();
    const frozen = readManagerReviewCanon({ repositoryRoot: root });
    const siblingTwo = { ...context, sourceSlot: '02', invocationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    const before = renderManagerReviewBriefBatch(frozen, [context, siblingTwo]);

    writeFileSync(join(root, '.cursor/rules/flow-manager-browser-turn-monitoring.mdc'), [
      '## Launch and observation',
      'Changed selected bytes for <ISSUE_URL>.',
      '',
      '## Other',
      'outside-v1',
      '',
    ].join('\n'));
    commitAll(root, 'selected section drift');

    const stillFrozen = renderManagerReviewBriefBatch(frozen, [context, siblingTwo]);
    expect(stillFrozen.map((entry) => entry.text)).toEqual(before.map((entry) => entry.text));

    const comparison = compareManagerReviewBrief(before[1]!.text, siblingTwo, { repositoryRoot: root });
    expect(comparison.ok).toBe(false);
    if (comparison.ok) throw new Error('expected canonical mismatch');
    expect(comparison.mismatch.cause).toContain('canonical_prompt_mismatch:');
    expect(comparison.mismatch.cause).toContain('expected_sha256=');
    expect(comparison.mismatch.cause).toContain('observed_sha256=');
    expect(comparison.mismatch.cause).toContain('.cursor/rules/flow-manager-browser-turn-monitoring.mdc@');
  });

  it('admits exact current canonical bytes and strips gate-only stage context before transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-valid-'));
    roots.push(root);
    const actualContext: ManagerReviewBriefContext = {
      ...context,
      repositoryFullName: 'chetwerikoff/orchestrator-pack',
    };
    const rendered = renderManagerReviewBrief(readManagerReviewCanon(), actualContext);
    const input = join(root, 'prompt.txt');
    writeFileSync(input, rendered.text);
    const delegated: string[][] = [];

    const exitCode = await runStateLightEntry([
      'turn',
      '--invocation-id', actualContext.invocationId,
      '--input', input,
      '--reviewer-source-output', join(root, 'source.txt'),
      '--reviewer-source', 'direct-publication/v1',
      '--repository', actualContext.repositoryFullName,
      '--issue-number', String(actualContext.issueNumber),
      '--source-revision', actualContext.sourceRevision,
      '--stage', actualContext.stage,
      '--source-slot', actualContext.sourceSlot,
    ], {
      runTurn: async (argv) => {
        delegated.push([...argv]);
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).not.toContain('--stage');
    expect(delegated[0]).not.toContain('--source-slot');
    expect(delegated[0]).toContain('--reviewer-source');
  });

  it('rejects hand-written state-light direct-publication input before the browser core', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-input-'));
    roots.push(root);
    const input = join(root, 'prompt.txt');
    writeFileSync(input, 'hand-written reviewer prompt\n');
    const capture = captureWrite(process.stdout);
    const delegated: string[][] = [];
    try {
      const exitCode = await runStateLightEntry([
        'turn',
        '--invocation-id', context.invocationId,
        '--input', input,
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'direct-publication/v1',
        '--repository', 'chetwerikoff/orchestrator-pack',
        '--issue-number', '1431',
        '--source-revision', 'r07',
        '--stage', 'architectural-review',
        '--source-slot', '01',
      ], {
        runTurn: async (argv) => {
          delegated.push([...argv]);
          return 0;
        },
      });
      expect(exitCode).not.toBe(0);
      expect(delegated).toHaveLength(0);
      const result = JSON.parse(capture.lines.join('').trim()) as {
        state: string;
        cause: string;
        send_count: number;
      };
      expect(result.state).toBe('input_invalid');
      expect(result.send_count).toBe(0);
      expect(result.cause).toMatch(/^canonical_prompt_mismatch:/);
    } finally {
      capture.restore();
    }
  });

  it('refuses legacy direct publication before delegating to legacy browser code', async () => {
    const capture = captureWrite(process.stdout);
    try {
      const exitCode = await runLegacyBrowserTurnCli([
        'turn',
        '--invocation-id', context.invocationId,
        '--reviewer-source-output', 'unused.txt',
      ]);
      expect(exitCode).not.toBe(0);
      const result = JSON.parse(capture.lines.join('').trim()) as {
        state: string;
        cause: string;
        send_count: number;
      };
      expect(result).toMatchObject({
        state: 'input_invalid',
        cause: 'input_invalid:legacy_direct_publication_turn_refused',
        send_count: 0,
      });
    } finally {
      capture.restore();
    }
  });

  it('requires stage and source-slot in long-running direct publication before spawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opk-manager-review-long-run-'));
    roots.push(root);
    const capture = captureWrite(process.stderr);
    try {
      const exitCode = await runBrowserAdapter([
        '--run-identity', 'run-1',
        '--attempt-identity', 'attempt-1',
        '--handoff-receipt', join(root, 'handoff.json'),
        '--invocation-id', context.invocationId,
        '--terminal-envelope', join(root, 'terminal.json'),
        '--output', join(root, 'output.json'),
        '--reviewer-source-output', join(root, 'source.txt'),
        '--reviewer-source', 'direct-publication/v1',
        '--repository', 'example/repo',
        '--issue-number', '1431',
        '--source-revision', 'r07',
      ]);
      expect(exitCode).toBe(2);
      expect(capture.lines.join('')).toContain('direct_publication_arguments_required');
    } finally {
      capture.restore();
    }
  });
});
