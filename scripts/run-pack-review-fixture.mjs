#!/usr/bin/env node
/**
 * Run pack review parsing on captured reviewer stdout (Claude bridge path).
 * Invoked from scripts/run-pack-review-claude.ps1 to avoid argv limits on --fixture-stdout.
 *
 * Usage: node --import tsx scripts/run-pack-review-fixture.mjs --fixture-file <path> [review.ts flags]
 */
import { readFileSync } from 'node:fs';
import { executeReview } from '../plugins/ao-codex-pr-reviewer/lib/review_core.ts';

function usage() {
  return [
    'Usage: run-pack-review-fixture.mjs --fixture-file <path> [review options]',
    '  --fixture-file <path>   Reviewer stdout to parse (required)',
    '  --repo-root, --base, --issue, --pr-number, --model, --source  (same as review.ts)',
  ].join('\n');
}

function parseArgs(argv) {
  let fixtureFile;
  const forward = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixture-file') {
      fixtureFile = argv[++i];
      continue;
    }
    forward.push(arg);
  }
  if (!fixtureFile) {
    throw new Error(usage());
  }
  return { fixtureFile, forward };
}

function parseReviewForward(argv) {
  let repoRoot = process.cwd();
  let baseRef = 'origin/main';
  let issueNumber;
  let prNumber;
  let model;
  let source;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--repo-root':
        repoRoot = argv[++i] ?? repoRoot;
        break;
      case '--base':
        baseRef = argv[++i] ?? baseRef;
        break;
      case '--issue':
        issueNumber = Number(argv[++i]);
        break;
      case '--pr-number':
        prNumber = Number(argv[++i]);
        break;
      case '--model':
        model = argv[++i];
        break;
      case '--source':
        source = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }

  return { repoRoot, baseRef, issueNumber, prNumber, model, source };
}

try {
  const { fixtureFile, forward } = parseArgs(process.argv.slice(2));
  const options = parseReviewForward(forward);
  const fixtureStdout = readFileSync(fixtureFile, 'utf8');

  const result = executeReview({
    repoRoot: options.repoRoot,
    baseRef: options.baseRef,
    issueNumber: options.issueNumber,
    prNumber: options.prNumber,
    model: options.model,
    source: options.source ?? 'codex-local',
    fixtureStdout,
  });

  for (const line of result.logLines) {
    console.error(line);
  }
  if (result.aoStdout) {
    const out = result.aoStdout.endsWith('\n') ? result.aoStdout : `${result.aoStdout}\n`;
    process.stdout.write(out);
  }
  process.exit(result.exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(2);
}
