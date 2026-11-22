#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
import { resolveTargetContext, type TargetContext, type TargetVerification } from './lib/target-context.ts';
import { parseRemoteSlug } from './lib/git-origin-slug.mjs';

export interface FormatterFixResult {
  readonly outcome: 'published' | 'clean' | 'refused' | 'gpt';
  readonly message: string;
}

interface FormatterFixDeps {
  readonly run?: typeof runProcessSync;
  readonly home?: string;
  readonly diagnostic?: (text: string) => void;
}

type FormatterDeclaration = NonNullable<TargetVerification['formatter']>;

interface CheckRun {
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly head_sha?: string;
  readonly details_url?: string | null;
  readonly html_url?: string | null;
  readonly output?: { readonly text?: string | null; readonly summary?: string | null };
}

interface JobStep {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
}

interface JobPayload {
  readonly id?: number;
  readonly run_id?: number;
  readonly run_attempt?: number;
  readonly head_sha?: string;
  readonly steps?: readonly JobStep[];
}

type CiRoute =
  | { readonly kind: 'lint'; readonly skippedDownstream: boolean; readonly attempt: number | null }
  | { readonly kind: 'gpt'; readonly attempt: number | null; readonly errors: string }
  | { readonly kind: 'hold'; readonly reason: string };

type Ancestry =
  | { readonly kind: 'first' | 'rearmed' }
  | { readonly kind: 'blocked'; readonly reason: string };

const LINT_STEP = /(?:^|[^a-z])(lint|format|fmt|ruff|style)(?:[^a-z]|$)/iu;
const SUBSTANTIVE_STEP = /(?:^|[^a-z])(typecheck|type-check|mypy|pyright|test|tests|pytest|vitest)(?:[^a-z]|$)/iu;
const NO_GUESSED_GPT = 'reread the current PR head, run attempt and step conclusions. Do not send a guessed GPT diagnosis';
const NO_STYLE_GPT = 'Do not send a GPT style turn';

class RouteStop extends Error {
  readonly routeNext: string;

  constructor(message: string, routeNext: string) {
    super(message);
    this.name = 'RouteStop';
    this.routeNext = routeNext;
  }
}

function declaredChecks(formatter: FormatterDeclaration): readonly string[] {
  return formatter.checks ?? (formatter.check ? [formatter.check] : []);
}

function clip(text: string): string {
  const clean = text.replace(/\0/g, '').trim();
  if (!clean) return '(no decoded error lines)';
  return clean.length > 2000 ? clean.slice(-2000) : clean;
}

function jobIdFromUrl(url: string | null | undefined): number | null {
  const match = /\/actions\/runs\/\d+\/job\/(\d+)/u.exec(url ?? '');
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function stepKind(name: string): 'lint' | 'substantive' | 'other' {
  if (SUBSTANTIVE_STEP.test(name)) return 'substantive';
  if (LINT_STEP.test(name)) return 'lint';
  return 'other';
}

function toolMissing(result: ProcessResult, output: string): boolean {
  return result.exitCode === 126 || result.exitCode === 127 || /command not found|Failed to spawn/iu.test(output);
}

/** The selected card owns the commands; all edits and commits belong to our disposable checkout. */
export function runManagerFormatterFix(context: TargetContext, pr: number, deps: FormatterFixDeps = {}): FormatterFixResult {
  const formatter = context.verification?.formatter;
  const refuse = (message: string, next: string): FormatterFixResult =>
    ({ outcome: 'refused', message: `${message}; next step: ${next}` });
  if (!formatter) return refuse('no formatter declared', 'route the CI failure to GPT with its error lines');
  const checks = declaredChecks(formatter);
  if (formatter.fix.length === 0 || checks.length === 0) {
    return refuse('formatter card is invalid', 'correct the formatter card so fix and exactly one of check or checks is present, then retry');
  }
  if (!Number.isSafeInteger(pr) || pr <= 0) return refuse('invalid PR number', 'pass --pr <positive PR number>');

  const run = deps.run ?? runProcessSync;
  const diagnostic = deps.diagnostic ?? ((text: string) => process.stderr.write(`${text}\n`));
  const ghBin = fileURLToPath(new URL('./gh', import.meta.url));
  let checkout: string | undefined;
  let failingCommand = '';
  let failingOutput = '';
  let changedFiles = '(none)';
  let cleanupFailure = '';
  let nextStep = 're-read the PR through scripts/gh and retry';
  let result: FormatterFixResult = refuse('formatter repair failed', nextStep);
  const execute = (cwd: string, command: string, args: readonly string[]) => {
    failingCommand = [command, ...args].join(' ');
    const commandResult = run({ command, args, cwd, inheritParentEnv: true, timeoutMs: 240_000 });
    failingOutput = [commandResult.stdout, commandResult.stderr, commandResult.error].filter(Boolean).join('\n').trim();
    return commandResult;
  };
  const git = (cwd: string, args: readonly string[]) => execute(cwd, 'git', args);
  const requiredGit = (cwd: string, args: readonly string[]): string => {
    const commandResult = git(cwd, args);
    if (!commandResult.ok) throw new Error('Git operation failed');
    return commandResult.stdout.trim();
  };
  // Snapshot reads must not replace the formatter command's failure text, and
  // must hash worktree bytes. Porcelain only says that a path is dirty, so a
  // second edit of an already-dirty file would look unchanged.
  const quietGit = (cwd: string, args: readonly string[], allowDifference: boolean): string => {
    const commandResult = run({ command: 'git', args, cwd, inheritParentEnv: true, timeoutMs: 240_000 });
    if (!commandResult.ok && !(allowDifference && commandResult.exitCode === 1)) {
      failingCommand = ['git', ...args].join(' ');
      failingOutput = [commandResult.stdout, commandResult.stderr, commandResult.error].filter(Boolean).join('\n').trim();
      throw new Error('Git operation failed');
    }
    return commandResult.stdout.trim();
  };
  const trackedSnapshot = (cwd: string): string => {
    const index = quietGit(cwd, ['ls-files', '--stage'], false);
    const paths = quietGit(cwd, ['ls-files', '-z'], false).split('\0').filter(Boolean);
    const present: string[] = [];
    const rows = paths.map((path) => {
      try {
        const mode = (statSync(join(cwd, path)).mode & 0o777).toString(8);
        present.push(path);
        return `${path}\t${mode}`;
      } catch {
        return `${path}\tdeleted`;
      }
    });
    let hashes: string[] = [];
    if (present.length > 0 && present.every((path) => !path.includes('\n'))) {
      const hashed = run({
        command: 'git', args: ['hash-object', '--stdin-paths'], cwd,
        input: `${present.join('\n')}\n`, inheritParentEnv: true, timeoutMs: 240_000,
      });
      if (hashed.ok) hashes = hashed.stdout.trim().split(/\r?\n/u);
    }
    if (hashes.length !== present.length) {
      hashes = present.map((path) => {
        const hashed = run({
          command: 'git', args: ['hash-object', '--', path], cwd,
          inheritParentEnv: true, timeoutMs: 240_000,
        });
        return hashed.ok ? hashed.stdout.trim() : 'unreadable';
      });
    }
    let hashIndex = 0;
    const work = rows.map((row) => row.endsWith('\tdeleted') ? row : `${row}\t${hashes[hashIndex++]}`);
    return `${index}\n--\n${work.join('\n')}`;
  };

  try {
    const response = execute(context.packRoot, ghBin, ['api', `repos/${context.repository}/pulls/${pr}`]);
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
        nextStep = `${NO_GUESSED_GPT}`;
        const ci = diagnoseCi(sha);
        const history = readAncestry(sha);
        if (ci.kind === 'gpt') {
          result = {
            outcome: 'gpt',
            message: `proven non-lint failure on ${sha} run attempt ${ci.attempt ?? 'unknown'}; ${ci.errors}; next step: send these substantive errors to the existing GPT fixer and do not publish a formatter commit`,
          };
        } else if (ci.kind === 'hold') {
          result = refuse(ci.reason, NO_GUESSED_GPT);
        } else if (history.kind === 'blocked') {
          result = refuse(
            `formatter episode is unchanged (${history.reason}) on ${sha}`,
            'diagnose card, tool, lockfile or CI parity and do not publish another formatter commit',
          );
        } else {
          nextStep = 'repair the checkout creation failure and retry';
          const root = join(deps.home ?? homedir(), '.local', 'state', 'orchestrator-pack', 'checkouts');
          mkdirSync(root, { recursive: true });
          checkout = mkdtempSync(join(root, `formatter-pr-${pr}-`));
          requiredGit(context.primaryRoot, ['worktree', 'add', '--detach', checkout, sha]);
          const episode = history.kind === 'rearmed' ? `new diagnostic episode eligible on ${sha}; ` : '';
          let lintDefect = false;
          for (const command of checks) {
            const before = trackedSnapshot(checkout);
            const ran = execute(checkout, 'sh', ['-lc', command]);
            if (trackedSnapshot(checkout) !== before) {
              throw new RouteStop(
                `pre-fix check mutated tracked files: ${command}`,
                `correct the card check so the diagnostic is read-only. ${NO_STYLE_GPT}`,
              );
            }
            if (!ran.ok) {
              if (toolMissing(ran, failingOutput)) {
                throw new RouteStop(
                  `formatter tool failed: ${command}`,
                  `install the exact-head tool or correct the card command. ${NO_STYLE_GPT}`,
                );
              }
              lintDefect = true;
            }
          }
          if (!lintDefect) {
            throw new RouteStop(
              `${episode}local formatter checks passed on ${sha} while CI lint/format is red`,
              `compare the exact-head lockfile, Makefile and CI runner with the card. Do not publish a formatter commit. ${NO_STYLE_GPT}`,
            );
          }
          for (const command of formatter.fix) {
            if (!execute(checkout, 'sh', ['-lc', command]).ok) {
              throw new RouteStop('formatter fix failed', `repair the formatter command or card. ${NO_STYLE_GPT}`);
            }
          }
          for (const command of checks) {
            const before = trackedSnapshot(checkout);
            const ran = execute(checkout, 'sh', ['-lc', command]);
            if (trackedSnapshot(checkout) !== before) {
              throw new RouteStop(
                `post-fix check mutated tracked files: ${command}`,
                `correct the card check so it does not change tracked files or the index. ${NO_STYLE_GPT}`,
              );
            }
            if (!ran.ok) {
              const why = toolMissing(ran, failingOutput) ? 'formatter tool failed' : 'formatter check failed';
              throw new RouteStop(`${why}: ${command}`, `repair the failing card check. ${NO_STYLE_GPT}`);
            }
          }
          const changed = requiredGit(checkout, ['status', '--porcelain', '--untracked-files=all']);
          changedFiles = changed || '(none)';
          nextStep = 'repair the reported staging or commit hook failure and retry';
          requiredGit(checkout, ['reset', '--quiet', sha]);
          const untracked = requiredGit(checkout, ['ls-files', '--others', '--exclude-standard']);
          if (untracked) diagnostic(`Untracked tool outputs excluded from publication and removed during cleanup:\n${untracked}`);
          requiredGit(checkout, ['add', '--update']);
          const staged = requiredGit(checkout, ['diff', '--cached', '--name-only']);
          if (!staged) {
            result = refuse(
              `${episode}formatter produced no tracked diff on ${sha} while CI lint/format is red`,
              `diagnose card, tool or CI drift. ${NO_STYLE_GPT}`,
            );
          } else {
            const checkedTree = requiredGit(checkout, ['write-tree']);
            requiredGit(checkout, ['commit', '-m', 'Apply formatter']);
            const headTree = requiredGit(checkout, ['rev-parse', 'HEAD^{tree}']);
            if (headTree !== checkedTree) {
              throw new RouteStop(
                'commit hook changed the tracked tree after the checked formatter index',
                `repair the hook so the published tree matches the checked staged tree. ${NO_STYLE_GPT}`,
              );
            }
            const published = requiredGit(checkout, ['rev-parse', 'HEAD']);
            nextStep = `configure exactly one origin push URL for ${context.repository} and run the command again`;
            const destinations = requiredGit(checkout, ['remote', 'get-url', '--push', '--all', 'origin'])
              .split(/\r?\n/u).filter(Boolean);
            if (destinations.length !== 1
              || parseRemoteSlug(destinations[0]!)?.toLowerCase() !== context.repository.toLowerCase()) {
              failingOutput = 'Origin push destination is ambiguous or does not match the project repository (URLs omitted).';
              throw new Error('formatter commit was not published: origin push destination does not uniquely match the project repository');
            }
            nextStep = 'repair the reported push failure and retry';
            const pushed = git(checkout, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
            if (!pushed.ok) {
              if (/non-fast-forward|fetch first|stale info/iu.test(pushed.stderr)) {
                nextStep = 'run the command again on the new head';
              }
              throw new Error('formatter commit was not published: push failed');
            }
            const unknown = ci.skippedDownstream
              ? 'later steps were not executed and stay unknown; this is not a whole-CI formatter-only claim; '
              : '';
            result = {
              outcome: 'published',
              message: `published formatter commit ${published}; ${unknown}next step: arm the CI self-wake`,
            };
          }
        }
      }
    }
  } catch (error) {
    const routed = error instanceof RouteStop ? error.routeNext : undefined;
    if (routed) nextStep = routed;
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
        rmSync(checkout, { recursive: true, force: true });
        const cleanup = git(context.primaryRoot, ['worktree', 'remove', '--force', checkout]);
        if (!cleanup.ok && !cleanup.stderr.includes('is not a working tree')) {
          cleanupFailure = `checkout registration cleanup failed for ${checkout}; next step: inspect git worktree list and remove this command-owned registration`;
        }
      }
    }
  }
  return cleanupFailure ? { outcome: 'refused', message: `${result.message}; ${cleanupFailure}` } : result;

  function readGhJson(endpoint: string): unknown {
    const response = execute(context.packRoot, ghBin, ['api', endpoint]);
    if (!response.ok) throw new RouteStop(`CI evidence is unavailable for ${endpoint}`, NO_GUESSED_GPT);
    try {
      return JSON.parse(response.stdout) as unknown;
    } catch {
      throw new RouteStop('CI evidence is unreadable', NO_GUESSED_GPT);
    }
  }

  function diagnoseCi(sha: string): CiRoute {
    const payload = readGhJson(`repos/${context.repository}/commits/${sha}/check-runs`) as {
      total_count?: number;
      check_runs?: CheckRun[];
    };
    const runs = payload.check_runs ?? [];
    if (!Number.isInteger(payload.total_count) || payload.total_count !== runs.length || runs.length === 0) {
      return { kind: 'hold', reason: `CI check-runs for ${sha} are incomplete or absent` };
    }
    if (runs.some((run) => run.head_sha && run.head_sha !== sha)) {
      return { kind: 'hold', reason: `CI evidence is not bound to current head ${sha}` };
    }
    if (runs.some((run) => run.status !== 'completed')) {
      return { kind: 'hold', reason: `CI run for ${sha} is still pending` };
    }
    const jobIds = [...new Set(runs.map((run) => jobIdFromUrl(run.details_url ?? run.html_url)).filter((id): id is number => id !== null))];
    const jobs: JobPayload[] = [];
    for (const id of jobIds) {
      const job = readGhJson(`repos/${context.repository}/actions/jobs/${id}`) as JobPayload;
      if (job.head_sha && job.head_sha !== sha) {
        return { kind: 'hold', reason: `CI job evidence is not bound to current head ${sha}` };
      }
      jobs.push(job);
    }
    const latest = new Map<number, JobPayload>();
    for (const job of jobs) {
      const runId = job.run_id ?? job.id ?? 0;
      const previous = latest.get(runId);
      if (!previous || (job.run_attempt ?? 0) >= (previous.run_attempt ?? 0)) latest.set(runId, job);
    }
    const steps = [...latest.values()].flatMap((job) => job.steps ?? []);
    const attempt = [...latest.values()].reduce<number | null>((max, job) => {
      const value = job.run_attempt;
      if (!Number.isInteger(value)) return max;
      return max === null || value! > max ? value! : max;
    }, null);
    if (jobIds.length > 0 && steps.length === 0) {
      return { kind: 'hold', reason: `CI job steps for ${sha} are unavailable` };
    }
    const lintFailed: string[] = [];
    const substantiveFailed: string[] = [];
    const unknownFailed: string[] = [];
    let skippedDownstream = false;
    for (const step of steps) {
      const name = step.name ?? '';
      const kind = stepKind(name);
      const completed = step.status === 'completed';
      const failed = completed && (step.conclusion === 'failure' || step.conclusion === 'timed_out');
      const unknown = !completed || step.conclusion === 'skipped' || step.conclusion == null;
      if (failed && kind === 'lint') lintFailed.push(name);
      else if (failed && kind === 'substantive') substantiveFailed.push(name);
      else if (failed) unknownFailed.push(name || '(unnamed step)');
      else if (unknown && kind !== 'lint') skippedDownstream = true;
    }
    const texts: string[] = [];
    for (const run of runs) {
      if (run.output?.text) texts.push(run.output.text);
      if (run.output?.summary) texts.push(run.output.summary);
    }
    for (const id of jobIds) {
      const logs = execute(context.packRoot, ghBin, [
        'api', `repos/${context.repository}/actions/jobs/${id}/logs`, '--allow-escape-sequences',
      ]);
      if (logs.ok && !logs.stdout.includes('\0')) texts.push(logs.stdout);
    }
    const errors = clip(texts.join('\n'));
    if (substantiveFailed.length > 0) {
      const lintNote = lintFailed.length > 0 ? ` lint steps also failed: ${lintFailed.join(', ')};` : '';
      return {
        kind: 'gpt',
        attempt,
        errors: `substantive steps failed: ${substantiveFailed.join(', ')};${lintNote} errors: ${errors}`,
      };
    }
    if (unknownFailed.length > 0 || (lintFailed.length === 0 && jobIds.length === 0)) {
      return {
        kind: 'hold',
        reason: unknownFailed.length > 0
          ? `unclassifiable failing step ${unknownFailed.join(', ')} on ${sha}`
          : `no step-level CI evidence for ${sha}`,
      };
    }
    if (lintFailed.length === 0) {
      return { kind: 'hold', reason: `required CI on ${sha} has no proved lint or substantive failing step` };
    }
    return { kind: 'lint', skippedDownstream, attempt };
  }

  function readAncestry(sha: string): Ancestry {
    const listed = git(context.primaryRoot, ['rev-list', '--first-parent', '--parents', sha]);
    if (!listed.ok) return { kind: 'blocked', reason: 'first-parent ancestry is missing' };
    const rows = listed.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.trim().split(/\s+/u));
    let formatterAt = -1;
    const subjectOf = (commit: string): string => requiredGit(context.primaryRoot, ['log', '-1', '--format=%s', commit]);
    for (let index = 0; index < rows.length; index += 1) {
      if (subjectOf(rows[index]![0]!) === 'Apply formatter') {
        formatterAt = index;
        break;
      }
    }
    if (formatterAt === -1) return { kind: 'first' };
    for (let index = 0; index <= formatterAt; index += 1) {
      if ((rows[index]?.slice(1).length ?? 0) !== 1) {
        return { kind: 'blocked', reason: 'first-parent line is ambiguous' };
      }
    }
    if (formatterAt === 0) return { kind: 'blocked', reason: 'current head is an Apply formatter commit' };
    let changed = false;
    for (let index = 0; index < formatterAt; index += 1) {
      const row = rows[index]!;
      const commit = row[0]!;
      const parent = row[1]!;
      if (subjectOf(commit) === 'Apply formatter') continue;
      let tree = '';
      let parentTree = '';
      try {
        tree = requiredGit(context.primaryRoot, ['rev-parse', `${commit}^{tree}`]);
        parentTree = requiredGit(context.primaryRoot, ['rev-parse', `${parent}^{tree}`]);
      } catch {
        return { kind: 'blocked', reason: 'first-parent ancestry is missing' };
      }
      if (tree !== parentTree) changed = true;
    }
    if (!changed) return { kind: 'blocked', reason: 'no tracked-content change after the formatter repair' };
    return { kind: 'rearmed' };
  }
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
