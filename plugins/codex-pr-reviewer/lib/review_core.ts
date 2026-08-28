import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewPrompt } from './prompt.ts';
import { selectReviewVerdict } from './verdict.ts';
import {
  defaultSourceFromEnv,
  emitPackReviewPayload,
  emitTerminalVerdictPayload,
  formatGithubComment,
  toRuntimeFindings,
} from './emit.ts';
import {
  resolveIssueNumber,
  resolveScopeContext,
  scopeUnavailableWarningFinding,
} from './scope_context.ts';
import { runCodexReview, type RunCodexReviewResult } from './run_review.ts';
import { createReviewerBudgetLedger } from './reviewer_budget.ts';
import {
  buildReviewerFailureLogLines,
  classifyReviewerFailure,
  isSpawnTimeoutResult,
} from './reviewer_failure.ts';
import type { ReviewSource, StructuredFinding } from './types.ts';

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
  fixtureTimedOut?: boolean;
  githubCommentFile?: string;
  skipCodex?: boolean;
}

export interface ReviewResult {
  exitCode: number;
  logLines: string[];
  reviewStdout: string;
  structuredFindings: StructuredFinding[];
  githubComment?: string;
}

/** orchestrator-pack root where npm ci installs workspace links for native TypeScript execution. */
export function resolvePackRepoRoot(): string {
  const libDir = dirname(fileURLToPath(import.meta.url));
  return join(libDir, '..', '..', '..');
}

export function hasReviewRuntimeDeps(root: string): boolean {
  return existsSync(join(root, 'node_modules', '@orchestrator-pack', 'shared', 'package.json'));
}

function carryoverBundlePath(): string | undefined {
  const value = process.env.PACK_REVIEW_CARRYOVER_BUNDLE_PATH?.trim();
  return value || undefined;
}

function appendCarryoverEvidence(payload: string, bundlePath: string | undefined): string {
  if (!bundlePath) return payload;
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as { bundleDigest?: unknown };
  if (typeof bundle.bundleDigest !== 'string') return payload;
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, bundleDigest: bundle.bundleDigest });
}

/** Roots to probe for installed workspace dependencies: pack checkout first, then optional reviewed repo. */
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
      'Pack Codex review requires workspace dependencies from npm ci in the pack checkout (or in the reviewed repo for AO workspaces).',
      `Checked: ${roots.join(', ')}`,
      'Run npm ci --include=dev in the pack checkout, then invoke the governed TypeScript pack-review entrypoint.',
    ].join('\n'),
  );
  process.exit(1);
}

export function executeReview(options: ReviewOptions): ReviewResult {
  // Budget syntax/range must fail before dependency probes, issue/scope reads, prompt
  // construction, claims, subprocesses, or any durable/external effect.
  const budgetLedger = createReviewerBudgetLedger();
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

  const bundlePath = carryoverBundlePath();
  const prompt = bundlePath
    ? `${buildReviewPrompt({ scope, source, baseRef: options.baseRef })}\n\n## Conflict carry-over review (mandatory)\n\nRead the immutable merge-resolution bundle at \`${bundlePath}\` and review the exact H1 resolution described by it before returning a verdict.\n`
    : buildReviewPrompt({ scope, source, baseRef: options.baseRef });

  if (options.skipCodex && options.fixtureStdout === undefined) {
    return {
      exitCode: 0,
      logLines: ['prompt-only mode'],
      reviewStdout: prompt,
      structuredFindings: [],
    };
  }

  const codex = runCodexReview({
    repoRoot: options.repoRoot,
    baseRef: options.baseRef,
    prompt,
    model: options.model,
    // Sandbox trust is fail-closed: only an explicit --source may grant coworker-capable mode.
    source: options.source,
    fixtureStdout: options.fixtureStdout,
    fixtureProcessJsonl: options.fixtureProcessJsonl,
    fixtureSessionJsonl: options.fixtureSessionJsonl,
    fixtureTimedOut: options.fixtureTimedOut,
    budgetLedger,
  });

  if (isSpawnTimeoutResult(codex)) {
    const failureClass = classifyReviewerFailure({ codex, ledger: codex.budgetLedger });
    logLines.push(...buildReviewerFailureLogLines(codex.budgetLedger, failureClass));
    return {
      exitCode: 1,
      logLines,
      reviewStdout: '',
      structuredFindings: [],
    };
  }

  if (codex.exitCode !== 0) {
    logLines.push(...summarizeReviewerProcessFailure(codex));
    return {
      exitCode: codex.exitCode || 1,
      logLines,
      reviewStdout: '',
      structuredFindings: [],
    };
  }

  const parsed = selectReviewVerdict({
    processJsonl: codex.processJsonl,
    lastMessage: codex.lastMessage,
    stderr: codex.stderr,
    repoRoot: options.repoRoot,
    sessionJsonl: options.fixtureSessionJsonl,
    source,
  });

  if (parsed.kind === 'error') {
    const failureClass = classifyReviewerFailure({ codex, parsed, ledger: codex.budgetLedger });
    logLines.push(...buildReviewerFailureLogLines(codex.budgetLedger, failureClass));
    logLines.push(parsed.message);
    return {
      exitCode: 1,
      logLines,
      reviewStdout: '',
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
      reviewStdout: appendCarryoverEvidence(
        emitTerminalVerdictPayload({
          verdict: 'clean',
          findings: toRuntimeFindings(findings),
        }),
        bundlePath,
      ),
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
    reviewStdout: appendCarryoverEvidence(
      emitPackReviewPayload(toRuntimeFindings(findings)),
      bundlePath,
    ),
    structuredFindings: findings,
    githubComment,
  };
}
