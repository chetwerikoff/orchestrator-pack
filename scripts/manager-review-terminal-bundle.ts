#!/usr/bin/env node
import './toolchain/native-entrypoint-preflight.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManagerReviewTerminalBundle,
  terminalBundleFileName,
  writeManagerReviewTerminalBundle,
} from './lib/manager-review-terminal-bundle.ts';
import {
  inspectManagerCliInvocation,
  type ManagerCliDeclaration,
} from './lib/manager-cli-contract.ts';

const MANAGER_REVIEW_TERMINAL_BUNDLE_CLI = {
  program: 'manager-review-terminal-bundle.ts',
  options: [
    { flag: '--repo', value: 'owner/name' },
    { flag: '--issue-number', value: 'n', required: true },
    { flag: '--source-revision', value: 'rNN', required: true },
    { flag: '--review-dir', value: 'path', required: true },
    { flag: '--output', value: 'path' },
    { flag: '--author-dispositions', value: 'path' },
  ],
} as const satisfies ManagerCliDeclaration;

export const MANAGER_REVIEW_TERMINAL_BUNDLE_CLI_DECLARATION = MANAGER_REVIEW_TERMINAL_BUNDLE_CLI;

function option(argv: readonly string[], key: string): string | undefined {
  const flag = `--${key}`;
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function runManagerReviewTerminalBundleCli(argv: readonly string[]): number {
  const inspected = inspectManagerCliInvocation(MANAGER_REVIEW_TERMINAL_BUNDLE_CLI, argv);
  if (inspected.help) {
    process.stdout.write(inspected.help + '\n');
    return 0;
  }
  if (inspected.error) {
    process.stderr.write(inspected.error + '\n');
    return 2;
  }
  try {
    const repo = option(argv, 'repo') ?? 'chetwerikoff/orchestrator-pack';
    const issueRaw = option(argv, 'issue-number');
    const sourceRevision = option(argv, 'source-revision');
    const reviewDir = option(argv, 'review-dir');
    if (!issueRaw || !/^[1-9][0-9]*$/.test(issueRaw)) throw new Error('--issue-number is required');
    if (!sourceRevision) throw new Error('--source-revision is required');
    if (!reviewDir) throw new Error('--review-dir is required');
    const issueNumber = Number(issueRaw);
    const output = option(argv, 'output') ?? resolve(reviewDir, terminalBundleFileName(issueNumber, sourceRevision));
    const bundle = buildManagerReviewTerminalBundle({
      repositoryFullName: repo,
      issueNumber,
      sourceRevision,
      reviewDir,
      authorDispositionsPath: option(argv, 'author-dispositions'),
    });
    writeManagerReviewTerminalBundle(output, bundle);
    process.stdout.write(`${JSON.stringify({
      schema: 'manager-review-terminal-input-bundle-produced/v1',
      output,
      reviewEpisodeId: bundle.reviewEpisodeId,
      sourceRevision: bundle.sourceRevision,
      predecessorStage: bundle.predecessorStage,
    })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === entry) {
  process.exitCode = runManagerReviewTerminalBundleCli(process.argv.slice(2));
}
