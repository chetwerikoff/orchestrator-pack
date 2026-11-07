#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';
import { resolveTargetContext, type TargetContext } from './lib/target-context.ts';

export interface FormatterFixResult {
  readonly outcome: 'published' | 'clean' | 'refused';
  readonly message: string;
}

interface FormatterFixDeps {
  readonly run?: typeof runProcessSync;
  readonly home?: string;
  readonly diagnostic?: (text: string) => void;
}

/** The selected card owns the commands; all edits and commits belong to our disposable checkout. */
export function runManagerFormatterFix(context: TargetContext, pr: number, deps: FormatterFixDeps = {}): FormatterFixResult {
  const formatter = context.verification?.formatter;
  const refuse = (message: string, next: string): FormatterFixResult =>
    ({ outcome: 'refused', message: `${message}; next step: ${next}` });
  if (!formatter) return refuse('no formatter declared', 'route the CI failure to GPT with its error lines');
  if (!Number.isSafeInteger(pr) || pr <= 0) return refuse('invalid PR number', 'pass --pr <positive PR number>');

  const run = deps.run ?? runProcessSync;
  const diagnostic = deps.diagnostic ?? ((text: string) => process.stderr.write(`${text}\n`));
  let checkout: string | undefined;
  let failingCommand = '';
  let failingOutput = '';
  let changedFiles = '(none)';
  let cleanupFailure = '';
  let nextStep = 're-read the PR through scripts/gh and retry';
  let result: FormatterFixResult;
  const execute = (cwd: string, command: string, args: readonly string[]) => {
    failingCommand = [command, ...args].join(' ');
    const result = run({ command, args, cwd, inheritParentEnv: true, timeoutMs: 240_000 });
    failingOutput = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();
    return result;
  };
  const git = (cwd: string, args: readonly string[]) => execute(cwd, 'git', args);
  const requiredGit = (cwd: string, args: readonly string[]): string => {
    const result = git(cwd, args);
    if (!result.ok) throw new Error('Git operation failed');
    return result.stdout.trim();
  };

  try {
    const response = execute(context.packRoot, fileURLToPath(new URL('./gh', import.meta.url)),
      ['api', `repos/${context.repository}/pulls/${pr}`]);
    if (!response.ok) throw new Error('PR read failed');
    const pull = JSON.parse(response.stdout) as {
      state?: string; head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
    };
    const sha = pull.head?.sha;
    const branch = pull.head?.ref;
    if (pull.state !== 'open') {
      result = refuse('PR is not open', 'select an open PR and run the command again');
    } else if (pull.head?.repo?.full_name?.toLowerCase() !== context.repository.toLowerCase()) {
      result = refuse('PR head repository does not match the project card', 'route the fork PR failure to GPT with its error lines');
    } else if (branch === context.defaultBranch) {
      result = refuse('PR head is the default branch', 'move the implementation to a non-default PR branch and run the command again');
    } else if (!sha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(sha) || !branch
      || !git(context.primaryRoot, ['check-ref-format', `refs/heads/${branch}`]).ok) {
      result = refuse('PR head identity is invalid', 're-read the PR head and retry with a valid PR branch');
    } else {
      nextStep = 'repair the origin fetch failure and run the command again on the current head';
      requiredGit(context.primaryRoot, ['fetch', '--no-tags', 'origin', `refs/heads/${branch}`]);
      const fetched = requiredGit(context.primaryRoot, ['rev-parse', 'FETCH_HEAD']);
      if (fetched !== sha) {
        result = refuse('PR branch moved before checkout', 'run the command again on the new head');
      } else {
        nextStep = 'repair the checkout creation failure and retry';
        const root = join(deps.home ?? homedir(), '.local', 'state', 'orchestrator-pack', 'checkouts');
        mkdirSync(root, { recursive: true });
        checkout = mkdtempSync(join(root, `formatter-pr-${pr}-`));
        requiredGit(context.primaryRoot, ['worktree', 'add', '--detach', checkout, sha]);
        nextStep = 'send the remaining check errors to GPT';
        for (const command of formatter.fix) {
          if (!execute(checkout, 'sh', ['-lc', command]).ok) throw new Error('formatter fix failed');
        }
        if (!execute(checkout, 'sh', ['-lc', formatter.check]).ok) {
          throw new Error('formatter check still fails after the fix');
        }
        const changed = requiredGit(checkout, ['status', '--porcelain', '--untracked-files=all']);
        changedFiles = changed || '(none)';
        if (!changed) {
          result = { outcome: 'clean', message: `formatter clean on ${sha}; next step: route the CI failure to GPT with its error lines` };
        } else {
          nextStep = 'repair the reported staging or commit hook failure and retry';
          requiredGit(checkout, ['add', '--all']);
          requiredGit(checkout, ['commit', '-m', 'Apply formatter']);
          const published = requiredGit(checkout, ['rev-parse', 'HEAD']);
          nextStep = 'repair the reported push failure and retry';
          const pushed = git(checkout, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
          if (!pushed.ok) {
            // A rejected normal push never retries against a moving author branch.
            if (/non-fast-forward|fetch first|stale info/iu.test(pushed.stderr)) {
              nextStep = 'run the command again on the new head';
            }
            throw new Error('formatter commit was not published: push failed');
          }
          result = { outcome: 'published', message: `published formatter commit ${published}; next step: arm the CI self-wake` };
        }
      }
    }
  } catch (error) {
    diagnostic(`Failed command: ${failingCommand || 'read PR response'}`);
    if (failingOutput) diagnostic(failingOutput);
    if (checkout) {
      const changed = git(checkout, ['status', '--short', '--untracked-files=all']);
      diagnostic(`Changed files:\n${changed.stdout.trim() || changedFiles}`);
    } else {
      diagnostic('Changed files: (none; checkout not created)');
    }
    result = refuse(error instanceof Error ? error.message : 'formatter repair failed', nextStep);
  } finally {
    if (checkout) {
      const removed = git(context.primaryRoot, ['worktree', 'remove', '--force', checkout]);
      if (!removed.ok) {
        // An unsuccessful worktree add may have left only the empty reserved directory.
        rmSync(checkout, { recursive: true, force: true });
        const cleanup = git(context.primaryRoot, ['worktree', 'remove', '--force', checkout]);
        if (!cleanup.ok && !cleanup.stderr.includes('is not a working tree')) {
          cleanupFailure = `checkout registration cleanup failed for ${checkout}; next step: inspect git worktree list and remove this command-owned registration`;
        }
      }
    }
  }
  return cleanupFailure ? { outcome: 'refused', message: `${result.message}; ${cleanupFailure}` } : result;
}

export function formatterFixCli(argv: readonly string[]): FormatterFixResult {
  const usage = 'Usage: manager-formatter-fix.ts --project <id> --pr <n>';
  try {
    if (argv.length !== 4 || argv[0] !== '--project' || argv[2] !== '--pr'
      || !argv[1] || !/^[1-9]\d*$/u.test(argv[3] ?? '')) throw new Error(usage);
    return runManagerFormatterFix(resolveTargetContext({ projectId: argv[1] }), Number(argv[3]));
  } catch (error) {
    return { outcome: 'refused', message: `${error instanceof Error ? error.message : 'formatter repair failed'}; next step: correct the project selection or formatter card declaration and retry. ${usage}` };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = formatterFixCli(process.argv.slice(2));
  process.stdout.write(`${result.message}\n`);
  process.exitCode = result.outcome === 'refused' ? 1 : 0;
}
