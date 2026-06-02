import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewPrompt } from './prompt.js';
import { selectReviewVerdict } from './verdict.js';
import {
  defaultSourceFromEnv,
  emitAoReviewPayload,
  formatGithubComment,
  toAoFindings,
} from './emit.js';
import {
  resolveIssueNumber,
  resolveScopeContext,
  scopeUnavailableWarningFinding,
} from './scope_context.js';
import { runCodexReview, type RunCodexReviewResult } from './run_review.js';
import type { ReviewSource, StructuredFinding } from './types.js';

const REVIEW_FAILURE_LINE =
  /^(ERROR:|error:|Fatal|review-failure:)/i;
const REVIEW_FAILURE_HINT = /usage limit|ERR_MODULE_NOT_FOUND|mutually exclusive|exited 1/i;

/** Build log lines AO should capture in terminationReason when the reviewer process fails. */
export function summarizeReviewerProcessFailure(codex: RunCodexReviewResult): string[] {
  const lines: string[] = [`codex exec review exited ${codex.exitCode}`];
  const combined = [codex.stderr, codex.lastMessage, codex.processJsonl]
    .map((chunk) => chunk?.trim() ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!combined) {
    lines.push(
      'reviewer produced no stderr/stdout — check Codex auth, quota, sandbox, and REVIEW_COMMAND preflight',
    );
    return lines;
  }

  const notable = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (REVIEW_FAILURE_LINE.test(line) || REVIEW_FAILURE_HINT.test(line)));

  if (notable.length > 0) {
    for (const line of notable.slice(-4)) {
      lines.push(line);
    }
    return lines;
  }

  const oneLine = combined.replace(/\s+/g, ' ');
  const snippet = oneLine.length > 400 ? `${oneLine.slice(0, 400)}...` : oneLine;
  lines.push(`reviewer output: ${snippet}`);
  return lines;
}

export interface ReviewOptions {
  repoRoot: string;
  baseRef: string;
  source?: ReviewSource;
  model?: string;
  issueNumber?: number;
  prNumber?: number;
  prBodyFile?: string;
  fixtureStdout?: string;
  fixtureProcessJsonl?: string;
  fixtureSessionJsonl?: string;
  githubCommentFile?: string;
  skipCodex?: boolean;
}

export interface ReviewResult {
  exitCode: number;
  logLines: string[];
  aoStdout: string;
  structuredFindings: StructuredFinding[];
  githubComment?: string;
}

/** orchestrator-pack root (where npm ci installs tsx for the wrapper process). */
export function resolvePackRepoRoot(): string {
  const libDir = dirname(fileURLToPath(import.meta.url));
  return join(libDir, '..', '..', '..');
}

export function hasReviewRuntimeDeps(root: string): boolean {
  return existsSync(join(root, 'node_modules', 'tsx', 'package.json'));
}

/** Roots to probe for tsx: pack checkout first, then optional reviewed repo (AO op-rev). */
export function reviewDependencySearchRoots(repoRoot: string): string[] {
  const packRoot = resolvePackRepoRoot();
  if (repoRoot === packRoot) {
    return [packRoot];
  }
  return [packRoot, repoRoot];
}

function assertReviewDependencies(repoRoot: string): void {
  const roots = reviewDependencySearchRoots(repoRoot);
  if (roots.some((root) => hasReviewRuntimeDeps(root))) {
    return;
  }
  console.error(
    [
      'Pack Codex review requires tsx from npm ci in the pack checkout (or in the reviewed repo for AO workspaces).',
      `Checked: ${roots.join(', ')}`,
      'Run npm ci --include=dev in the pack checkout, or scripts/run-pack-review.ps1 for AO local review.',
    ].join('\n'),
  );
  process.exit(1);
}

export function executeReview(options: ReviewOptions): ReviewResult {
  const source = options.source ?? defaultSourceFromEnv();
  const logLines: string[] = [];

  if (options.fixtureStdout === undefined && !options.skipCodex) {
    assertReviewDependencies(options.repoRoot);
  }

  const issueNumber = resolveIssueNumber({
    repoRoot: options.repoRoot,
    explicitIssue: options.issueNumber,
    prNumber: options.prNumber,
    prBodyFile: options.prBodyFile,
  });

  const scope = resolveScopeContext({
    repoRoot: options.repoRoot,
    issueNumber,
  });

  const prompt = buildReviewPrompt({ scope, source, baseRef: options.baseRef });

  if (options.skipCodex && options.fixtureStdout === undefined) {
    return {
      exitCode: 0,
      logLines: ['prompt-only mode'],
      aoStdout: prompt,
      structuredFindings: [],
    };
  }

  const codex = runCodexReview({
    repoRoot: options.repoRoot,
    baseRef: options.baseRef,
    prompt,
    model: options.model,
    source,
    fixtureStdout: options.fixtureStdout,
    fixtureProcessJsonl: options.fixtureProcessJsonl,
    fixtureSessionJsonl: options.fixtureSessionJsonl,
  });

  if (codex.exitCode !== 0) {
    logLines.push(...summarizeReviewerProcessFailure(codex));
    return {
      exitCode: codex.exitCode || 1,
      logLines,
      aoStdout: '',
      structuredFindings: [],
    };
  }

  const parsed = selectReviewVerdict({
    processJsonl: codex.processJsonl,
    lastMessage: codex.lastMessage,
    stderr: codex.stderr,
    sessionJsonl: options.fixtureSessionJsonl,
    source,
  });

  if (parsed.kind === 'error') {
    logLines.push(parsed.message);
    return {
      exitCode: 1,
      logLines,
      aoStdout: '',
      structuredFindings: [],
    };
  }

  if (parsed.kind === 'clean') {
    let findings: StructuredFinding[] = [];
    if (!scope.hasScope) {
      findings = [scopeUnavailableWarningFinding(source)];
    }

    const githubComment = options.githubCommentFile
      ? formatGithubComment({
          model: options.model ?? 'gpt-5.5',
          findings,
          clean: true,
        })
      : undefined;

    if (options.githubCommentFile && githubComment) {
      writeFileSync(options.githubCommentFile, githubComment, 'utf8');
    }

    return {
      exitCode: 0,
      logLines,
      aoStdout: findings.length > 0 ? emitAoReviewPayload(toAoFindings(findings)) : '',
      structuredFindings: findings,
      githubComment,
    };
  }

  let findings = parsed.findings.map((finding) => ({
    ...finding,
    source: finding.source || source,
  }));

  if (!scope.hasScope) {
    findings = [...findings, scopeUnavailableWarningFinding(source)];
  }

  const githubComment = options.githubCommentFile
    ? formatGithubComment({
        model: options.model ?? 'gpt-5.5',
        findings,
        clean: false,
      })
    : undefined;

  if (options.githubCommentFile && githubComment) {
    writeFileSync(options.githubCommentFile, githubComment, 'utf8');
  }

  return {
    exitCode: 0,
    logLines,
    aoStdout: emitAoReviewPayload(toAoFindings(findings)),
    structuredFindings: findings,
    githubComment,
  };
}
