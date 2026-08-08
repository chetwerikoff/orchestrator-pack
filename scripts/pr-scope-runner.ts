#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync } from './kernel/subprocess.ts';
import { runGhJsonCommand } from './lib/gh-signal-classifier.ts';
import {
  acquirePrScopeDiff,
  evaluatePrScope,
  formatScopeCheckComment,
  resolveIssueNumberForFetch,
  type PrScopeCheckInput,
  type PrScopeCheckResult,
  type PrScopeDiffResult,
} from './pr-scope-check.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TRUSTED_ROOT = dirname(SCRIPT_DIR);
const TRACKED_GH = join(TRUSTED_ROOT, 'scripts', 'gh');

export const OPERATOR_ADOPTION_MIGRATION_PATH = 'docs/migration_notes.md';
export const OPERATOR_ADOPTION_WAIVER = 'No operator adoption required';
export const OPERATOR_ADOPTION_TRIGGER_PATHS = [
  'scripts/runtime/registry.ts',
  'scripts/orchestrator-side-process-registry.json',
  'scripts/orchestrator-wake-supervisor.ps1',
  '.claude/skills/change-orchestrator-runtime/SKILL.md',
  '.cursor/skills/change-orchestrator-runtime/SKILL.md',
] as const;

export type RunnerFailureReason =
  | 'runner_configuration'
  | 'pr_unreadable'
  | 'operator_adoption_handoff';

export type PrScopeRunnerResult =
  | PrScopeCheckResult
  | {
      ok: false;
      reason: RunnerFailureReason;
      message: string;
    };

export interface RunnerReadResult {
  ok: boolean;
  body?: string;
  reason?: string;
}

export interface RunnerPublishResult {
  ok: boolean;
  diagnostic?: string;
}

export interface PrScopeRunnerDependencies {
  readPrBody: (repository: string, prNumber: number) => RunnerReadResult;
  readIssueBody: (repository: string, issueNumber: number) => RunnerReadResult;
  publishComment: (
    repository: string,
    prNumber: number,
    body: string,
  ) => RunnerPublishResult;
  acquireDiff: (input: PrScopeCheckInput) => PrScopeDiffResult;
}

export interface PrScopeRunnerOutcome {
  result: PrScopeRunnerResult;
  exitCode: 0 | 1 | 2;
  comment: string | null;
  commentAttempted: boolean;
  commentPublished: boolean;
  commentDiagnostic?: string;
}

function normalizePrBody(body: string): string {
  return body.replace(/^\uFEFF/, '').trim();
}

function normalizeOperatorPath(path: string): string {
  let normalized = path.trim().replaceAll('\\', '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

export function checkOperatorAdoption(
  changedPaths: readonly string[],
  prBody: string,
): { ok: true } | { ok: false; message: string; triggeredPaths: string[] } {
  const normalized = changedPaths.map(normalizeOperatorPath);
  const triggeredPaths = OPERATOR_ADOPTION_TRIGGER_PATHS.filter((path) =>
    normalized.includes(path),
  );
  if (triggeredPaths.length === 0) return { ok: true };
  if (normalized.includes(OPERATOR_ADOPTION_MIGRATION_PATH)) return { ok: true };

  const bodyText = prBody.replace(/^\uFEFF/, '');
  const bodyLines = bodyText.split(/\r?\n/).map((line) => line.trimEnd());
  if (bodyLines.includes(OPERATOR_ADOPTION_WAIVER)) return { ok: true };

  return {
    ok: false,
    message:
      'operator-facing runtime or supervisor change lacks docs/migration_notes.md or the exact PR-body waiver (No operator adoption required)',
    triggeredPaths: [...triggeredPaths],
  };
}

function readBodyFromGh(
  args: readonly string[],
  expectedLabel: string,
): RunnerReadResult {
  const read = runGhJsonCommand({
    command: TRACKED_GH,
    args,
    cwd: TRUSTED_ROOT,
    expectedRoot: 'object',
  });
  if (!read.ok) {
    return { ok: false, reason: `${expectedLabel} read failed (${read.reason})` };
  }
  const value = read.value as { body?: unknown };
  if (typeof value.body !== 'string') {
    return { ok: false, reason: `${expectedLabel} read returned a non-string body` };
  }
  return { ok: true, body: value.body };
}

export function createDefaultPrScopeRunnerDependencies(): PrScopeRunnerDependencies {
  return {
    readPrBody(repository, prNumber) {
      return readBodyFromGh(
        ['pr', 'view', String(prNumber), '--repo', repository, '--json', 'body'],
        'PR body',
      );
    },
    readIssueBody(repository, issueNumber) {
      return readBodyFromGh(
        ['issue', 'view', String(issueNumber), '--repo', repository, '--json', 'body'],
        'Issue body',
      );
    },
    publishComment(repository, prNumber, body) {
      const result = runProcessSync({
        command: TRACKED_GH,
        args: [
          'pr',
          'comment',
          String(prNumber),
          '--repo',
          repository,
          '--body',
          body,
        ],
        cwd: TRUSTED_ROOT,
        inheritParentEnv: true,
      });
      return result.ok
        ? { ok: true }
        : {
            ok: false,
            diagnostic: `scope result comment publication failed (exit ${
              result.exitCode ?? 'unknown'
            })`,
          };
    },
    acquireDiff: acquirePrScopeDiff,
  };
}

function parsePositiveInteger(value: string | undefined): number | null {
  const text = value?.trim() ?? '';
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

function formatRunnerComment(result: PrScopeRunnerResult): string {
  return formatScopeCheckComment(result as PrScopeCheckResult);
}

function finishOutcome(
  result: PrScopeRunnerResult,
  exitCode: 0 | 1 | 2,
  repository: string | null,
  prNumber: number | null,
  deps: PrScopeRunnerDependencies,
): PrScopeRunnerOutcome {
  const comment = repository && prNumber ? formatRunnerComment(result) : null;
  if (!repository || !prNumber || !comment) {
    return {
      result,
      exitCode,
      comment,
      commentAttempted: false,
      commentPublished: false,
    };
  }

  try {
    const publication = deps.publishComment(repository, prNumber, comment);
    return {
      result,
      exitCode,
      comment,
      commentAttempted: true,
      commentPublished: publication.ok,
      ...(publication.diagnostic
        ? { commentDiagnostic: publication.diagnostic.slice(0, 512) }
        : {}),
    };
  } catch (error) {
    return {
      result,
      exitCode,
      comment,
      commentAttempted: true,
      commentPublished: false,
      commentDiagnostic: `scope result comment publication failed: ${
        error instanceof Error ? error.message : String(error)
      }`.slice(0, 512),
    };
  }
}

export function runPrScopeRunner(
  env: NodeJS.ProcessEnv,
  deps: PrScopeRunnerDependencies = createDefaultPrScopeRunnerDependencies(),
): PrScopeRunnerOutcome {
  const prNumber = parsePositiveInteger(env.PR_NUMBER);
  const repository = env.GITHUB_REPOSITORY?.trim() || null;
  if (!prNumber || !repository) {
    return finishOutcome(
      {
        ok: false,
        reason: 'runner_configuration',
        message: 'PR_NUMBER and GITHUB_REPOSITORY are required for pr-scope-runner.ts',
      },
      2,
      repository,
      prNumber,
      deps,
    );
  }

  const prRead = deps.readPrBody(repository, prNumber);
  if (!prRead.ok || typeof prRead.body !== 'string') {
    return finishOutcome(
      {
        ok: false,
        reason: 'pr_unreadable',
        message: prRead.reason ?? 'PR body could not be read; retry command',
      },
      1,
      repository,
      prNumber,
      deps,
    );
  }
  const prBody = normalizePrBody(prRead.body);

  const issueNumber = resolveIssueNumberForFetch(prBody);
  let issueBody: string | null = null;
  if (issueNumber !== null) {
    const issueRead = deps.readIssueBody(repository, issueNumber);
    if (issueRead.ok && typeof issueRead.body === 'string') {
      issueBody = issueRead.body;
    }
  }

  const repoRoot = resolve(env.PR_SCOPE_REPO_ROOT?.trim() || TRUSTED_ROOT);
  const input: PrScopeCheckInput = {
    repoRoot,
    prBody,
    issueBody,
    prPaths: [],
    degradedMode: false,
    forkPr: parseBoolean(env.PR_HEAD_REPO_FORK),
    prNumber,
    prHeadRef: env.PR_HEAD_REF ?? '',
    sameRepo: parseBoolean(env.PR_HEAD_REPO_SAME),
    baseSha: env.PR_BASE_SHA ?? '',
    headSha: env.PR_HEAD_SHA ?? '',
  };

  const diff = deps.acquireDiff(input);
  if (!diff.ok) {
    const result: PrScopeCheckResult = {
      ok: false,
      reason: 'diff-incomplete',
      message: diff.message,
    };
    return finishOutcome(result, 1, repository, prNumber, deps);
  }

  const adoption = checkOperatorAdoption(diff.diff.operatorAdoptionPaths, prBody);
  if (!adoption.ok) {
    return finishOutcome(
      {
        ok: false,
        reason: 'operator_adoption_handoff',
        message: adoption.message,
      },
      1,
      repository,
      prNumber,
      deps,
    );
  }

  const result = evaluatePrScope({ ...input, prPaths: diff.diff.scopePaths });
  return finishOutcome(result, result.ok ? 0 : 1, repository, prNumber, deps);
}

function isDirectExecution(): boolean {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  );
}

if (isDirectExecution()) {
  const outcome = runPrScopeRunner(process.env);
  if (outcome.commentDiagnostic) {
    process.stderr.write(`${outcome.commentDiagnostic}\n`);
  }
  process.stdout.write(
    `${outcome.result.ok ? 'scope guard passed' : `scope guard failed: ${outcome.result.message}`}\n`,
  );
  process.exitCode = outcome.exitCode;
}
