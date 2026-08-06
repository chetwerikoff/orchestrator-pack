import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcessSync, type ProcessResult } from './kernel/subprocess.ts';

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ProcessResult {
  return runProcessSync({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    inheritParentEnv: true,
    encoding: 'utf8',
    timeoutMs: 30_000,
  });
}

function requireSuccess(
  command: string,
  args: readonly string[],
  cwd: string,
): ProcessResult {
  const result = run(command, args, { cwd });
  expect(result.exitCode, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
}

describe('Issue #1359 real worker-smoke entrypoint', () => {
  it('refreshes a changed generation before dispatch, executes the scenario, and closes the owned handle', () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-smoke-entrypoint-1359-'));
    const bin = join(root, 'bin');
    const callsPath = join(root, 'orca-calls.jsonl');
    const issueBodyPath = join(root, 'issue.md');
    mkdirSync(bin, { recursive: true });

    try {
      requireSuccess('git', ['init', '--quiet', '--initial-branch=main'], root);
      requireSuccess('git', ['config', 'user.email', 'worker-smoke@example.invalid'], root);
      requireSuccess('git', ['config', 'user.name', 'Worker Smoke Fixture'], root);
      writeFileSync(join(root, '.gitignore'), '*\n!.gitignore\n', 'utf8');
      requireSuccess('git', ['add', '.gitignore'], root);
      requireSuccess('git', ['commit', '--quiet', '-m', 'fixture'], root);
      const head = String(requireSuccess('git', ['rev-parse', 'HEAD'], root).stdout).trim();

      writeFileSync(issueBodyPath, [
        '```behavior-kind',
        'action-producing',
        '```',
        '',
        '```smoke-test-plan',
        'scenarios:',
        '  - action: execute real entrypoint | expected: sealed scenario report',
        '```',
        '',
      ].join('\n'), 'utf8');

      const fakeOrca = join(bin, 'orca');
      writeFileSync(fakeOrca, `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2).filter((value) => value !== '--json');
appendFileSync(process.env.FAKE_ORCA_CALLS, JSON.stringify(args) + '\\n', 'utf8');
const root = process.env.FAKE_ORCA_ROOT;
const head = process.env.FAKE_ORCA_HEAD;
const showCallCount = readFileSync(process.env.FAKE_ORCA_CALLS, 'utf8')
  .split(/\\r?\\n/u)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((entry) => entry[0] === 'terminal' && entry[1] === 'show')
  .length;
const terminal = {
  handle: 'terminal-1359',
  title: 'smoke-1359',
  incarnationId: showCallCount >= 2
    ? 'dispatch-generation-1359'
    : 'spawn-generation-1359',
  worktreePath: root,
  status: 'running',
};
const ok = (result) => process.stdout.write(JSON.stringify({ ok: true, result }));

if (args[0] === 'worktree' && args[1] === 'current') {
  ok({ worktree: { path: root, head, linkedIssue: 1359 } });
} else if (args[0] === 'terminal' && args[1] === 'create') {
  ok({ terminal: { ...terminal, incarnationId: 'create-generation-1359' } });
} else if (args[0] === 'terminal' && args[1] === 'show') {
  ok({ terminal });
} else if (args[0] === 'terminal' && args[1] === 'list') {
  ok({ terminals: [terminal] });
} else if (args[0] === 'terminal' && args[1] === 'send' && args.includes('--text')) {
  const text = args[args.indexOf('--text') + 1] || '';
  const runId = /run-id:\\s*([^\\r\\n]+)/u.exec(text)?.[1]?.trim();
  const artifactDir = /artifact-dir:\\s*([^\\r\\n]+)/u.exec(text)?.[1]?.trim();
  const progressPath = /Progress file:\\s*([^\\r\\n]+)/u.exec(text)?.[1]?.trim();
  if (!runId || !artifactDir || !progressPath) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: { code: 'fixture_binding_missing', message: 'prompt binding not found' },
    }));
    process.exitCode = 1;
  } else {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, 'delivery.sealed.json'), JSON.stringify({ runId }), 'utf8');
    writeFileSync(progressPath, [
      JSON.stringify({ runId, scenarioOrdinal: 1, phase: 'started' }),
      JSON.stringify({ runId, scenarioOrdinal: 1, phase: 'terminal', outcome: 'pass' }),
      '',
    ].join('\\n'), 'utf8');
    const fence = String.fromCharCode(96).repeat(3);
    const body = [
      fence + 'worker-smoke-report',
      'result: PASS',
      'tracked-files-unmodified: true',
      'scenarios:',
      '  - action: execute real entrypoint | expected: sealed scenario report | observed: production create lookup dispatch completed | outcome: pass',
      fence,
    ].join('\\n');
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');
    writeFileSync(path.join(artifactDir, 'completion-' + digest + '.body'), body, { flag: 'wx' });
    writeFileSync(
      path.join(artifactDir, 'completion-' + digest + '.sealed.json'),
      JSON.stringify({ runId, bodySha256: digest }),
      { flag: 'wx' },
    );
    ok({ sent: true });
  }
} else if (args[0] === 'terminal' && args[1] === 'close') {
  ok({ closed: true });
} else if (args[0] === 'terminal' && args[1] === 'read') {
  ok({ terminal: { handle: terminal.handle, status: 'running', tail: [], nextCursor: '1' } });
} else if (args[0] === 'terminal' && args[1] === 'wait') {
  ok({ wait: { handle: terminal.handle, condition: 'tui-idle', satisfied: true, status: 'running' } });
} else {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: { code: 'unexpected_fixture_operation', message: args.join(' ') },
  }));
  process.exitCode = 1;
}
`, 'utf8');
      chmodSync(fakeOrca, 0o755);

      const wrapper = resolve('scripts/worker-smoke-run');
      const result = run(wrapper, [
        'run',
        '--issue', '1359',
        '--pr', '1365',
        '--head-sha', head,
        '--issue-body-file', issueBodyPath,
        '--repo-root', root,
        '--cwd', root,
        '--dry-run',
        '--json',
      ], {
        cwd: root,
        env: {
          ORCA_CLI_COMMAND: fakeOrca,
          FAKE_ORCA_CALLS: callsPath,
          FAKE_ORCA_ROOT: root,
          FAKE_ORCA_HEAD: head,
        },
      });

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.signal).toBeNull();
      const lines = String(result.stdout).split(/\r?\n/u).filter((line) => line.trim());
      expect(lines).toHaveLength(1);
      const emitted = JSON.parse(lines[0]!) as {
        ok?: boolean;
        report?: {
          result?: string;
          terminalCleanup?: string;
          scenarios?: Array<{ action?: string; outcome?: string }>;
        };
      };
      expect(emitted).toMatchObject({
        ok: true,
        report: {
          result: 'PASS',
          terminalCleanup: 'closed_owned_handle',
          scenarios: [{ action: 'execute real entrypoint', outcome: 'pass' }],
        },
      });

      const calls = readFileSync(callsPath, 'utf8')
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as string[]);
      const operation = (args: readonly string[]): string => `${args[0] ?? ''} ${args[1] ?? ''}`;
      const operations = calls.map(operation);
      const createIndex = operations.indexOf('terminal create');
      const showIndexes = operations
        .map((value, index) => value === 'terminal show' ? index : -1)
        .filter((index) => index >= 0);
      const listIndex = operations.indexOf('terminal list', showIndexes[1] ?? 0);
      const sendIndex = operations.indexOf('terminal send');
      const closeIndex = operations.lastIndexOf('terminal close');
      expect(createIndex).toBeGreaterThanOrEqual(0);
      expect(showIndexes.length).toBeGreaterThanOrEqual(2);
      expect(showIndexes[0]).toBeGreaterThan(createIndex);
      expect(showIndexes[1]).toBeGreaterThan(showIndexes[0] ?? -1);
      expect(listIndex).toBeGreaterThan(showIndexes[1] ?? -1);
      expect(sendIndex).toBeGreaterThan(listIndex);
      expect(closeIndex).toBeGreaterThan(sendIndex);
      expect(operations.filter((value) => value === 'terminal send')).toHaveLength(1);
      expect(createHash('sha256').update(readFileSync(wrapper), 'utf8').digest('hex')).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
