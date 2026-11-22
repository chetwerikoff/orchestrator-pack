#!/usr/bin/env -S node --experimental-strip-types
import './toolchain/native-entrypoint-preflight.ts';

import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
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
  readonly conclusion?: string | null;
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

const SECRET_MATERIAL = /(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|Bearer\s+\S+|(?:token|password|secret|authorization)\s*[:=]\s*\S+/giu;

function sanitizeDiagnosticText(text: string): string | null {
  const stripped = text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B[@-Z\\-_]/gu, '');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(stripped) || /\r(?!\n)/u.test(stripped)) return null;
  const scrubbed = stripped.replace(SECRET_MATERIAL, '[redacted]').trim();
  return scrubbed || null;
}

function clip(text: string): string {
  return text.length > 2000 ? text.slice(-2000) : text;
}

function jobIdFromUrl(url: string | null | undefined): number | null {
  const match = /\/actions\/runs\/\d+\/job\/(\d+)/u.exec(url ?? '');
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function stepKind(name: string): 'lint' | 'substantive' | 'other' {
  const substantive = SUBSTANTIVE_STEP.test(name);
  const lint = LINT_STEP.test(name);
  if (substantive && lint) return 'other';
  if (substantive) return 'substantive';
  if (lint) return 'lint';
  return 'other';
}

function selectedAttemptJobs(jobs: readonly JobPayload[]): JobPayload[] {
  const byRun = new Map<number, JobPayload[]>();
  for (const job of jobs) {
    const runId = job.run_id ?? job.id ?? 0;
    const group = byRun.get(runId) ?? [];
    group.push(job);
    byRun.set(runId, group);
  }
  const selected: JobPayload[] = [];
  for (const group of byRun.values()) {
    const attempts = group.map((job) => job.run_attempt).filter((attempt): attempt is number => Number.isInteger(attempt));
    const latestAttempt = attempts.length > 0 ? Math.max(...attempts) : null;
    const seen = new Set<number>();
    for (const job of group) {
      if (latestAttempt !== null && job.run_attempt !== latestAttempt) continue;
      const id = job.id ?? 0;
      if (seen.has(id)) continue;
      seen.add(id);
      selected.push(job);
    }
  }
  return selected;
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
    const files: string[] = [];
    const rows: Array<{ kind: 'deleted' | 'link' | 'file'; text: string }> = paths.map((path) => {
      const full = join(cwd, path);
      let info;
      try {
        info = lstatSync(full);
      } catch {
        return { kind: 'deleted', text: `${path}\tdeleted` };
      }
      const mode = (info.mode & 0o777).toString(8);
      if (info.isSymbolicLink()) {
        try {
          return { kind: 'link', text: `${path}\tlink\t${mode}\t${readlinkSync(full)}` };
        } catch {
          throw new Error(`tracked symlink is unreadable: ${path}`);
        }
      }
      if (!info.isFile()) throw new Error(`tracked path is not a regular file: ${path}`);
      files.push(path);
      return { kind: 'file', text: `${path}\tfile\t${mode}` };
    });
    let hashes: string[] = [];
    if (files.length > 0 && files.every((path) => !path.includes('\n'))) {
      const hashed = run({
        command: 'git', args: ['hash-object', '--stdin-paths'], cwd,
        input: `${files.join('\n')}\n`, inheritParentEnv: true, timeoutMs: 240_000,
      });
      if (hashed.ok) hashes = hashed.stdout.trim().split(/\r?\n/u);
    }
    if (hashes.length !== files.length) {
      hashes = files.map((path) => {
        const hashed = run({
          command: 'git', args: ['hash-object', '--', path], cwd,
          inheritParentEnv: true, timeoutMs: 240_000,
        });
        return hashed.ok ? hashed.stdout.trim() : '';
      });
    }
    if (hashes.length !== files.length || hashes.some((hash) => !/^[0-9a-f]{40}$/u.test(hash))) {
      throw new Error('tracked file bytes are unreadable');
    }
    let hashIndex = 0;
    const work = rows.map((row) => row.kind === 'file' ? `${row.text}\t${hashes[hashIndex++]}` : row.text);
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
    const selected = selectedAttemptJobs(jobs);
    const failedJobs = selected.filter((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out');
    const successfulRunIds = new Set<number>();
    for (const job of selected) {
      if (job.conclusion === 'success') successfulRunIds.add(job.run_id ?? job.id ?? 0);
    }
    if (selected.length > 0 && failedJobs.length === 0) {
      return { kind: 'hold', reason: `required CI on ${sha} has no failed check-run or job conclusion` };
    }
    const steps = failedJobs.flatMap((job) => job.steps ?? []);
    let attempt: number | null = null;
    for (const job of failedJobs) {
      const value = job.run_attempt;
      if (typeof value !== 'number' || !Number.isInteger(value)) continue;
      if (attempt === null || value > attempt) attempt = value;
    }
    if (jobIds.length > 0 && steps.length === 0 && failedJobs.length > 0) {
      return { kind: 'hold', reason: `CI job steps for ${sha} are unavailable` };
    }
    const lintFailed: string[] = [];
    const substantiveFailed: string[] = [];
    const unknownFailed: string[] = [];
    const substantiveJobIds = new Set<number>();
    let skippedDownstream = false;
    for (const job of failedJobs) {
      for (const step of job.steps ?? []) {
        const name = step.name ?? '';
        const kind = stepKind(name);
        const completed = step.status === 'completed';
        const failed = completed && (step.conclusion === 'failure' || step.conclusion === 'timed_out');
        const unknown = !completed || step.conclusion === 'skipped' || step.conclusion == null;
        if (failed && kind === 'lint') lintFailed.push(name);
        else if (failed && kind === 'substantive') {
          substantiveFailed.push(name);
          if (Number.isInteger(job.id)) substantiveJobIds.add(job.id!);
        } else if (failed) unknownFailed.push(name || '(unnamed step)');
        else if (unknown && kind !== 'lint') skippedDownstream = true;
      }
    }
    const texts: string[] = [];
    const consider = (text: string | null | undefined) => {
      if (!text) return;
      const safe = sanitizeDiagnosticText(text);
      if (safe) texts.push(safe);
    };
    const evidenceIds = substantiveFailed.length > 0
      ? substantiveJobIds
      : new Set(failedJobs.map((job) => job.id).filter((id): id is number => Number.isInteger(id)));
    for (const run of runs) {
      const id = jobIdFromUrl(run.details_url ?? run.html_url);
      if (id === null || !evidenceIds.has(id)) continue;
      consider(run.output?.text);
      consider(run.output?.summary);
    }
    for (const id of evidenceIds) {
      const logs = execute(context.packRoot, ghBin, [
        'api', `repos/${context.repository}/actions/jobs/${id}/logs`,
      ]);
      if (logs.ok) consider(logs.stdout);
    }
    const errors = texts.join('\n').trim();
    if (substantiveFailed.length > 0) {
      if (!errors) {
        return {
          kind: 'hold',
          reason: `proved substantive step ${substantiveFailed.join(', ')} on ${sha} but sanitized CI logs and check output are unavailable; read the Actions job log for that step in the GitHub UI`,
        };
      }
      const lintNote = lintFailed.length > 0 ? ` lint steps also failed: ${lintFailed.join(', ')};` : '';
      return {
        kind: 'gpt',
        attempt,
        errors: `substantive steps failed: ${substantiveFailed.join(', ')};${lintNote} errors: ${clip(errors)}`,
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
    if (successfulRunIds.size > 0) {
      return {
        kind: 'hold',
        reason: `current-head CI has a successful job alongside a failed lint job, so required-check relevance is unproved on ${sha}`,
      };
    }
    return { kind: 'lint', skippedDownstream, attempt };
  }

  function readAncestry(sha: string): Ancestry {
    const listed = git(context.primaryRoot, [
      '--no-pager', 'log', '--first-parent', '--format=%H%x1e%P%x1e%T%x1e%s', sha,
    ]);
    if (!listed.ok) return { kind: 'blocked', reason: 'first-parent ancestry is missing' };
    const rows: Array<{ commit: string; parents: string[]; tree: string; subject: string }> = [];
    for (const line of listed.stdout.split(/\n/u)) {
      if (!line) continue;
      const [commit, parentField, tree, ...subjectParts] = line.split('\u001e');
      if (!commit || parentField === undefined || !tree || subjectParts.length === 0
        || !/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree)) {
        return { kind: 'blocked', reason: 'first-parent ancestry is missing' };
      }
      const parents = parentField ? parentField.split(' ') : [];
      if (parents.some((parent) => !/^[0-9a-f]{40}$/u.test(parent))) {
        return { kind: 'blocked', reason: 'first-parent ancestry is missing' };
      }
      rows.push({ commit, parents, tree, subject: subjectParts.join('\u001e') });
    }
    if (rows.length === 0 || rows[0]?.commit !== sha) {
      return { kind: 'blocked', reason: 'first-parent ancestry is missing' };
    }
    let formatterAt = -1;
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index]!.subject === 'Apply formatter') {
        formatterAt = index;
        break;
      }
    }
    if (formatterAt === -1) {
      if (rows.some((row) => row.parents.length > 1)) {
        return { kind: 'blocked', reason: 'first-parent line is ambiguous' };
      }
      const oldest = rows[rows.length - 1]!;
      const shallow = git(context.primaryRoot, ['rev-parse', '--is-shallow-repository']);
      if (!shallow.ok || shallow.stdout.trim() === 'true' || oldest.parents.length > 0) {
        return { kind: 'blocked', reason: 'first-parent ancestry is incomplete' };
      }
      return { kind: 'first' };
    }
    for (let index = 0; index <= formatterAt; index += 1) {
      if (rows[index]!.parents.length !== 1) return { kind: 'blocked', reason: 'first-parent line is ambiguous' };
    }
    if (formatterAt === 0) return { kind: 'blocked', reason: 'current head is an Apply formatter commit' };
    let changed = false;
    for (let index = 0; index < formatterAt; index += 1) {
      const row = rows[index]!;
      if (row.subject === 'Apply formatter') continue;
      const parent = rows[index + 1];
      if (!parent || parent.commit !== row.parents[0]) {
        return { kind: 'blocked', reason: 'first-parent ancestry is missing' };
      }
      if (row.tree !== parent.tree) changed = true;
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
