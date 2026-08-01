import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.ts';

type FindingsRegressionInput = Pick<typeof import('vitest'), 'describe' | 'expect' | 'it'> & {
  waitForSmokeChildCompletion: typeof import('../worker-smoke-run.ts').waitForSmokeChildCompletion;
};

export function registerWorkerSmokeFindingsRegressionTests(input: FindingsRegressionInput): void {
  const { describe, expect, it } = input;

  describe('ci diagnostic: legacy worker-smoke harness environment', () => {
    it('shows the exact payload produced with injected ORCA context', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-smoke-ci-diagnostic-'));
      const repoRoot = path.join(root, 'repo');
      fs.mkdirSync(repoRoot, { recursive: true });
      for (const [command, args] of [
        ['git', ['init']],
        ['git', ['config', 'user.email', 'smoke@example.invalid']],
        ['git', ['config', 'user.name', 'Smoke Harness']],
      ] as const) {
        const result = runProcessSync({ command, args, cwd: repoRoot, inheritParentEnv: true });
        expect(result.ok, result.stderr || result.error).toBe(true);
      }
      fs.writeFileSync(path.join(repoRoot, 'marker.txt'), 'current head\n', 'utf8');
      for (const args of [['add', 'marker.txt'], ['commit', '-m', 'fixture head']] as const) {
        const result = runProcessSync({ command: 'git', args, cwd: repoRoot, inheritParentEnv: true });
        expect(result.ok, result.stderr || result.error).toBe(true);
      }
      const headResult = runProcessSync({
        command: 'git',
        args: ['rev-parse', 'HEAD'],
        cwd: repoRoot,
        inheritParentEnv: true,
      });
      expect(headResult.ok, headResult.stderr || headResult.error).toBe(true);
      const result = runProcessSync({
        command: process.execPath,
        args: [
          '--experimental-strip-types',
          path.join(import.meta.dirname, '..', 'worker-smoke-run.ts'),
          'run',
          '--issue', '1125',
          '--pr', '1153',
          '--head-sha', headResult.stdout.trim(),
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
          ORCA_CLI_COMMAND: path.join(root, 'missing-orca'),
          FAKE_ORCA_SCENARIO: 'worktree_process_launch_failed',
          FAKE_ORCA_SENTINEL: 'RAW_RUN_SENTINEL_1125',
          FAKE_ORCA_LOG: path.join(root, 'orca-operations.log'),
          FAKE_ORCA_STATE: path.join(root, 'orca-state.json'),
          FAKE_ORCA_CWD: repoRoot,
          FAKE_ORCA_HEAD: headResult.stdout.trim(),
          ORCA_TERMINAL_HANDLE: 'injected-terminal',
          ORCA_WORKTREE_ID: 'injected-worktree',
          ORCA_PANE_KEY: 'injected-pane',
        },
      });
      const output = result.stdout.trim();
      const payload = JSON.parse(output.split(/\r?\n/u).at(-1) ?? '{}') as {
        nonPassCause?: string;
      };
      expect(
        payload.nonPassCause,
        JSON.stringify({ payload, stdout: result.stdout, stderr: result.stderr, result }),
      ).toBe('orca_control_plane_unavailable_preflight');
      fs.rmSync(root, { recursive: true, force: true });
    });
  });
}
