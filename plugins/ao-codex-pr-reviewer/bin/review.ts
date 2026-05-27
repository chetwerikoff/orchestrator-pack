#!/usr/bin/env tsx

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeReview, type ReviewOptions } from '../lib/review_core.js';
import type { ReviewSource } from '../lib/types.js';

function usage(): string {
  return [
    'Usage: review [options]',
    '  --repo-root <path>       Repository root (default: cwd)',
    '  --base <ref>             Base ref for codex exec review (default: origin/main)',
    '  --issue <n>              GitHub issue number (else AO_ISSUE_NUMBER or PR body)',
    '  --pr-number <n>          PR number to resolve linked issue via gh',
    '  --pr-body-file <path>    PR body file (GitHub Actions)',
    '  --model <name>           Codex model',
    '  --source <name>          codex-local | codex-github-action',
    '  --fixture-stdout <text>  Test hook: skip Codex, use this stdout',
    '  --github-comment-file <path>  Write PR comment markdown for Actions path',
    '  --prompt-only            Print assembled prompt and exit 0',
  ].join('\n');
}

function parseSource(value: string | undefined): ReviewSource | undefined {
  if (value === 'codex-local' || value === 'codex-github-action') {
    return value;
  }
  if (value) {
    throw new Error(`--source must be codex-local or codex-github-action (got ${value})`);
  }
  return undefined;
}

export function parseReviewArgs(argv: string[]): ReviewOptions & { promptOnly?: boolean } {
  let repoRoot = process.cwd();
  let baseRef = 'origin/main';
  let issueNumber: number | undefined;
  let prNumber: number | undefined;
  let prBodyFile: string | undefined;
  let model: string | undefined;
  let source: ReviewSource | undefined;
  let fixtureStdout: string | undefined;
  let githubCommentFile: string | undefined;
  let promptOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--repo-root':
        repoRoot = resolve(argv[++index] ?? repoRoot);
        break;
      case '--base':
        baseRef = argv[++index] ?? baseRef;
        break;
      case '--issue': {
        const raw = Number(argv[++index]);
        if (!Number.isInteger(raw) || raw <= 0) {
          throw new Error('--issue must be a positive integer');
        }
        issueNumber = raw;
        break;
      }
      case '--pr-number': {
        const raw = Number(argv[++index]);
        if (!Number.isInteger(raw) || raw <= 0) {
          throw new Error('--pr-number must be a positive integer');
        }
        prNumber = raw;
        break;
      }
      case '--pr-body-file':
        prBodyFile = argv[++index];
        break;
      case '--model':
        model = argv[++index];
        break;
      case '--source':
        source = parseSource(argv[++index]);
        break;
      case '--fixture-stdout':
        fixtureStdout = argv[++index] ?? '';
        break;
      case '--github-comment-file':
        githubCommentFile = argv[++index];
        break;
      case '--prompt-only':
        promptOnly = true;
        break;
      case '--help':
      case '-h':
        throw new Error(usage());
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  return {
    repoRoot,
    baseRef,
    issueNumber,
    prNumber,
    prBodyFile,
    model,
    source,
    fixtureStdout,
    githubCommentFile,
    skipCodex: promptOnly,
    promptOnly,
  };
}

function main(): void {
  let options: ReturnType<typeof parseReviewArgs>;
  try {
    options = parseReviewArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(2);
  }

  const result = executeReview(options);

  for (const line of result.logLines) {
    console.error(line);
  }

  if (options.promptOnly) {
    process.stdout.write(`${result.aoStdout}\n`);
    process.exit(0);
  }

  if (result.aoStdout) {
    process.stdout.write(result.aoStdout);
    if (!result.aoStdout.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }

  process.exit(result.exitCode);
}

function isDirectExecution(): boolean {
  const entryScript = process.argv[1];
  if (!entryScript) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryScript)
    );
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main();
}
