#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runProcessSync } from './kernel/subprocess.ts';

function runGit(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = runProcessSync({
    command: 'git',
    args: ['-C', root, ...args],
    cwd: root,
    inheritParentEnv: true,
    allowEmptyStdout: true,
  });
  return { ok: result.ok, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function parseArgs(argv: string[]): { installScopeGuard: boolean; uninstallScopeGuard: boolean } {
  const out = { installScopeGuard: false, uninstallScopeGuard: false };
  for (const arg of argv) {
    if (arg === '--install-scope-guard' || arg === '-InstallScopeGuard') out.installScopeGuard = true;
    else if (arg === '--uninstall-scope-guard' || arg === '-UninstallScopeGuard') out.uninstallScopeGuard = true;
    else throw new Error('unknown argument: ' + arg);
  }
  return out;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(import.meta.dirname, '..');
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim().split(/\r?\n/u)[0] !== 'true') {
    console.error('Not a git worktree yet. Run git init or clone this repository first, then rerun this script.');
    return 1;
  }
  const gitDirResult = runGit(root, ['rev-parse', '--git-dir']);
  if (!gitDirResult.ok || !gitDirResult.stdout.trim()) {
    console.error('Could not resolve .git directory: ' + gitDirResult.stderr.trim());
    return 1;
  }
  const rawGitDir = gitDirResult.stdout.trim().split(/\r?\n/u)[0]!;
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir);
  const hooksDir = join(gitDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });

  const scopeGuardMarker = '# orchestrator-pack scope-guard pre-commit';
  const scopeGuardHookPath = join(hooksDir, 'pre-commit');
  const scopeGuardSource = join(root, 'plugins/scope-guard/hooks/pre-commit');

  if (args.uninstallScopeGuard) {
    if (existsSync(scopeGuardHookPath)) {
      const existing = readFileSync(scopeGuardHookPath, 'utf8');
      if (existing.includes(scopeGuardMarker)) {
        rmSync(scopeGuardHookPath);
        console.log('Removed scope-guard pre-commit hook: ' + scopeGuardHookPath);
      } else {
        console.log('pre-commit hook exists but is not managed by orchestrator-pack; left unchanged.');
      }
    } else {
      console.log('No pre-commit hook to remove.');
    }
  }

  if (args.installScopeGuard) {
    if (!existsSync(scopeGuardSource)) {
      console.error('Scope-guard hook source not found: ' + scopeGuardSource);
      return 1;
    }
    if (existsSync(scopeGuardHookPath)) {
      const existing = readFileSync(scopeGuardHookPath, 'utf8');
      if (!existing.includes(scopeGuardMarker)) {
        console.error('Refusing to install scope-guard pre-commit hook: ' + scopeGuardHookPath + ' already exists and is not managed by orchestrator-pack.');
        console.error('Back up the existing hook, remove it manually, or chain the scope-guard call into your hook yourself.');
        console.error('Re-run with --uninstall-scope-guard only after replacing the hook with the managed version.');
        return 1;
      }
    }
    const scopeHook = [
      '#!/usr/bin/env sh',
      'set -eu',
      scopeGuardMarker,
      'ROOT="$(git rev-parse --show-toplevel)"',
      'exec "$ROOT/plugins/scope-guard/hooks/pre-commit"',
      '',
    ].join('\n');
    writeFileSync(scopeGuardHookPath, scopeHook, 'utf8');
    try { chmodSync(scopeGuardHookPath, 0o755); } catch {}
    try { chmodSync(scopeGuardSource, 0o755); } catch {}
    console.log('Installed scope-guard pre-commit hook: ' + scopeGuardHookPath);
    console.log('Issue identity is derived from the branch name by the installed scope-guard hook.');
    console.log('Re-run with --uninstall-scope-guard to remove the hook.');
  }

  const prePushPath = join(hooksDir, 'pre-push');
  const prePush = [
    '#!/usr/bin/env sh',
    'set -eu',
    'ROOT="$(git rev-parse --show-toplevel)"',
    'node --experimental-strip-types "$ROOT/scripts/verify.ts"',
    'node --experimental-strip-types "$ROOT/scripts/verify.ts" --reusable-only',
    '',
  ].join('\n');
  writeFileSync(prePushPath, prePush, 'utf8');
  try { chmodSync(prePushPath, 0o755); } catch {}
  console.log('Installed pre-push hook: ' + prePushPath);
  console.log('The hook runs the Node structure and reusable-content verifiers before every push.');
  if (!args.installScopeGuard) console.log('Pass --install-scope-guard to also install the scope-guard pre-commit hook.');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
