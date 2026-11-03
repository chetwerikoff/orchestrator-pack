import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  removeIdenticalLaunchCopies,
  runMergeCleanup,
  type GitRunner,
  type MergeCleanupDeps,
} from './merge-cleanup.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const LOCAL_CONFIG = '.claude/skills/discuss-with-gpt/local.config.json';

interface Fixture {
  readonly primary: string;
  readonly own: string;
  readonly manager: string;
  readonly smoke: string;
  readonly unrelated: string;
  readonly git: GitRunner;
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'merge-cleanup-')));
  roots.push(root);
  const primary = join(root, 'primary');
  mkdirSync(primary);
  sh(primary, 'init', '-q', '-b', 'main');
  sh(primary, 'config', 'user.email', 't@example.com');
  sh(primary, 'config', 'user.name', 't');
  writeFileSync(join(primary, '.gitignore'), '.env\n.claude/skills/discuss-with-gpt/local.config.json\n');
  writeFileSync(join(primary, 'a.txt'), 'a');
  sh(primary, 'add', '-A');
  sh(primary, 'commit', '-qm', 'init');
  writeFileSync(join(primary, '.env'), 'SECRET=1\n');
  mkdirSync(join(primary, '.claude/skills/discuss-with-gpt'), { recursive: true });
  writeFileSync(join(primary, LOCAL_CONFIG), '{"a":1}\n');
  const make = (name: string): string => {
    const path = join(root, name);
    sh(primary, 'worktree', 'add', '-q', '--detach', path);
    return path;
  };
  const own = make('own');
  const manager = make('manager');
  const smoke = make('smoke');
  const unrelated = make('unrelated');
  for (const tree of [manager, smoke, unrelated]) {
    writeFileSync(join(tree, '.env'), 'SECRET=1\n');
    mkdirSync(join(tree, '.claude/skills/discuss-with-gpt'), { recursive: true });
    writeFileSync(join(tree, LOCAL_CONFIG), '{"a":1}\n');
  }
  const git: GitRunner = (args) => {
    try {
      return { ok: true, stdout: execFileSync('git', ['-C', primary, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  };
  return { primary, own, manager, smoke, unrelated, git };
}

function deps(fx: Fixture, overrides: Partial<MergeCleanupDeps> = {}, log: string[] = []): MergeCleanupDeps {
  return {
    git: fx.git,
    holders: () => ({ holders: 0, unreadableCwd: 0, unreadableFd: 0 }),
    terminals: () => 0,
    removeTree: (path) => {
      log.push(`remove:${path}`);
      const result = fx.git(['worktree', 'remove', path]);
      return { ok: result.ok, detail: result.stderr };
    },
    send: (handle, text) => {
      log.push(`send:${handle}:${text}`);
      return { ok: true, detail: 'sent' };
    },
    ...overrides,
  };
}

describe('removeIdenticalLaunchCopies', () => {
  it('removes byte-identical ignored copies and preserves differing ones', () => {
    const fx = fixture();
    writeFileSync(join(fx.manager, '.env'), 'SECRET=changed\n');
    const result = removeIdenticalLaunchCopies(fx.manager, fx.primary, fx.git);
    expect(result.removed).toEqual([LOCAL_CONFIG]);
    expect(result.preserved).toEqual([{ path: '.env', reason: 'differs_from_primary' }]);
    expect(existsSync(join(fx.manager, '.env'))).toBe(true);
    expect(existsSync(join(fx.manager, LOCAL_CONFIG))).toBe(false);
  });

  it('preserves a copy whose primary counterpart is missing', () => {
    const fx = fixture();
    rmSync(join(fx.primary, '.env'));
    const result = removeIdenticalLaunchCopies(fx.manager, fx.primary, fx.git);
    expect(result.preserved).toEqual([{ path: '.env', reason: 'primary_copy_missing' }]);
    expect(existsSync(join(fx.manager, '.env'))).toBe(true);
  });
});

describe('runMergeCleanup', () => {
  it('removes every exact listed tree, keeps primary, own and unrelated trees, then reports MERGED after cleanup', () => {
    const fx = fixture();
    const log: string[] = [];
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.manager, fx.smoke, fx.own, join(fx.primary, '..', 'gone-already')],
        prNumber: 2758,
        mergeSha: 'abc123',
        orchestratorHandle: 'term_orch',
      },
      deps(fx, {}, log),
    );
    expect(report.blockers).toEqual([]);
    expect(report.message).toBe('MERGED 2758 abc123');
    expect(report.delivery.ok).toBe(true);
    expect(existsSync(fx.manager)).toBe(false);
    expect(existsSync(fx.smoke)).toBe(false);
    expect(existsSync(fx.unrelated)).toBe(true);
    expect(existsSync(fx.own)).toBe(true);
    expect(existsSync(fx.primary)).toBe(true);
    expect(report.trees.map((tree) => tree.status)).toEqual(['removed', 'removed', 'excluded_own_worktree', 'already_absent']);
    expect(report.trees[0]?.launchCopies?.removed).toEqual(['.env', LOCAL_CONFIG]);
    // the message is sent only after both removals
    expect(log.map((entry) => entry.split(':')[0])).toEqual(['remove', 'remove', 'send']);
    expect(report.order[report.order.length - 1]).toBe('send');
  });

  it('preserves a held tree and reports the exact blocker instead of MERGED', () => {
    const fx = fixture();
    const log: string[] = [];
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.manager, fx.smoke],
        prNumber: 9,
        mergeSha: 'def456',
        orchestratorHandle: 'term_orch',
      },
      deps(fx, {
        holders: (path) => (path === fx.smoke
          ? { holders: 2, unreadableCwd: 3, unreadableFd: 1 }
          : { holders: 0, unreadableCwd: 3, unreadableFd: 0 }),
      }, log),
    );
    expect(existsSync(fx.smoke)).toBe(true);
    expect(existsSync(join(fx.smoke, '.env'))).toBe(true);
    expect(existsSync(fx.manager)).toBe(false);
    expect(report.message).toMatch(/^CLEANUP_BLOCKED 9 def456 merged; .*smoke: 2 live process/);
    expect(report.message).not.toMatch(/[`!]/);
    expect(report.trees[1]?.unreadableProcessObservations).toEqual({ cwd: 3, fd: 1 });
    expect(log[log.length - 1]).toMatch(/^send:term_orch:CLEANUP_BLOCKED/);
  });

  it('never removes the primary checkout or an unlisted path named in the spec', () => {
    const fx = fixture();
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.primary, fx.primary],
        prNumber: 1,
        mergeSha: 's',
        orchestratorHandle: 'h',
      },
      deps(fx),
    );
    expect(existsSync(fx.primary)).toBe(true);
    expect(report.blockers).toHaveLength(1);
    expect(report.message).toMatch(/^CLEANUP_BLOCKED/);
  });

  it('does not claim delivery when the send fails', () => {
    const fx = fixture();
    const report = runMergeCleanup(
      {
        primaryRoot: fx.primary,
        ownWorktree: fx.own,
        listed: [fx.manager],
        prNumber: 1,
        mergeSha: 's',
        orchestratorHandle: 'h',
      },
      deps(fx, { send: () => ({ ok: false, detail: 'pane gone' }) }),
    );
    expect(report.delivery).toEqual({ ok: false, detail: 'pane gone' });
  });
});
