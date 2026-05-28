import { writeFileSync } from 'node:fs';
import { buildReviewPrompt } from './prompt.js';
import { parseCodexOutput } from './parse_output.js';
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
import { runCodexReview } from './run_review.js';
import type { ReviewSource, StructuredFinding } from './types.js';

export interface ReviewOptions {
  repoRoot: string;
  baseRef: string;
  source?: ReviewSource;
  model?: string;
  issueNumber?: number;
  prNumber?: number;
  prBodyFile?: string;
  fixtureStdout?: string;
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

export function executeReview(options: ReviewOptions): ReviewResult {
  const source = options.source ?? defaultSourceFromEnv();
  const logLines: string[] = [];

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

  const prompt = buildReviewPrompt({
    repoRoot: options.repoRoot,
    scope,
    source,
  });

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
    fixtureStdout: options.fixtureStdout,
  });

  if (codex.exitCode !== 0) {
    logLines.push(`codex exec review exited ${codex.exitCode}`);
    return {
      exitCode: codex.exitCode || 1,
      logLines,
      aoStdout: '',
      structuredFindings: [],
    };
  }

  const parsed = parseCodexOutput(codex.stdout);

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
          clean: findings.length === 0,
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
