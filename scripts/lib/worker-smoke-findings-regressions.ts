import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';

type FindingsRegressionInput = Pick<
  typeof import('vitest'),
  'describe' | 'expect' | 'it' | 'vi'
> & {
  waitForSmokeChildCompletion: typeof import('../worker-smoke-run.ts').waitForSmokeChildCompletion;
};

function requireCommand(
  expect: FindingsRegressionInput['expect'],
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  const result = runProcessSync({ command, args, cwd, inheritParentEnv: true });
  expect(result.ok, result.stderr || result.error).toBe(true);
  return result.stdout.trim();
}

export function registerWorkerSmokeFindingsRegressionTests(input: FindingsRegressionInput): void {
  const { describe, expect, it } = input;

  describe('ci diagnostic: post-reservation terminal create failure', () => {
    it('shows the terminal-create process-launch payload', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-create-diagnostic-'));
      const repoRoot = path.join(root, 'repo');
      const fakeOrcaPath = path.join(root, 'fake-orca.mjs');
      fs.mkdirSync(repoRoot, { recursive: true });
      requireCommand(expect, 'git', ['init'], repoRoot);
      requireCommand(expect, 'git', ['config', 'user.email', 'smoke@example.invalid'], repoRoot);
      requireCommand(expect, 'git', ['config', 'user.name', 'Smoke Harness'], repoRoot);
      fs.writeFileSync(path.join(repoRoot, 'marker.txt'), 'current head\n', 'utf8');
      requireCommand(expect, 'git', ['add', 'marker.txt'], repoRoot);
      requireCommand(expect, 'git', ['commit', '-m', 'fixture head'], repoRoot);
      const headSha = requireCommand(expect, 'git', ['rev-parse', 'HEAD'], repoRoot);

      fs.writeFileSync(fakeOrcaPath, [
        '#!/usr/bin/env node',
        "import { unlinkSync } from 'node:fs';",
        'const args = process.argv.slice(2);',
        "if (args[0] === 'worktree' && args[1] === 'current') {",
        '  unlinkSync(process.argv[1]);',
        `  process.stdout.write(JSON.stringify({ ok: true, result: { worktree: { path: ${JSON.stringify(repoRoot)}, head: ${JSON.stringify(headSha)} } } }) + '\\n');`,
        '  process.exit(0);',
        '}',
        "process.stdout.write(JSON.stringify({ ok: false, error: { code: 'unexpected', message: 'unexpected' } }) + '\\n');",
        'process.exit(1);',
      ].join('\n'), 'utf8');
      requireCommand(expect, 'chmod', ['+x', fakeOrcaPath], root);

      const result = runProcessSync({
        command: process.execPath,
        args: [
          '--experimental-strip-types',
          path.join(import.meta.dirname, '..', 'worker-smoke-run.ts'),
          'run',
          '--issue', '1125',
          '--pr', '1153',
          '--head-sha', headSha,
          '--issue-body-file', path.join(
            import.meta.dirname,
            '..',
            '..',
            'tests',
            'fixtures',
            'worker-smoke',
            'action-producing-with-plan.md',
          ),
          '--repo-root', repoRoot,
          '--cwd', repoRoot,
          '--dry-run',
          '--json',
        ],
        cwd: repoRoot,
        inheritParentEnv: true,
        env: {
          ORCA_CLI_COMMAND: fakeOrcaPath,
          ORCA_TERMINAL_HANDLE: 'injected-terminal',
          ORCA_WORKTREE_ID: 'injected-worktree',
          ORCA_PANE_KEY: 'injected-pane',
        },
      });
      const output = result.stdout.trim();
      const payload = JSON.parse(output.split(/\r?\n/u).at(-1) ?? '{}') as {
        nonPassCause?: string;
      };
      const admissionLockPath = path.join(
        repoRoot,
        '.orca-worker-smoke',
        'admission.lock.json',
      );
      const admissionLock = fs.existsSync(admissionLockPath)
        ? fs.readFileSync(admissionLockPath, 'utf8')
        : '<missing>';
      expect(
        payload.nonPassCause,
        JSON.stringify({
          payload,
          stdout: result.stdout,
          stderr: result.stderr,
          admissionLock,
          result,
        }),
      ).toBe('orca_control_plane_unavailable_preflight');
      fs.rmSync(root, { recursive: true, force: true });
    });
  });
}
