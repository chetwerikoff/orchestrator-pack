#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  formatReviewerReverifySummary,
  runContractEvidenceReverify,
  DEFAULT_REVERIFY_MANIFEST_PATH,
} from './lib/contract-evidence-reverify.js';
import {
  loadValidatedBoundSnapshotBody,
  resolveDefaultAoProjectId,
} from './lib/reverify-bound-issue-snapshot.js';
import { readLines, readText, resolveHeadSha } from './lib/reviewer-cli-io.js';
import { isDirectCliExecution, handleCliHelpOrJson, runReviewerTsCli, throwUnknownCliArg } from './lib/reviewer-ts-cli.js';

function usage(): string {
  return [
    'Usage: invoke-contract-evidence-reverify.ts [options]',
    '  --repo-root <path>',
    '  --trusted-base-root <path>',
    '  --review-target-root <path>',
    '  --manifest-path <path>',
    '  --snapshot-file <path>        Resolver-validated bound snapshot artifact path',
    '  --bound-snapshot-pr-number <n> PR number for snapshot provenance (required)',
    '  --bound-snapshot-issue-number <n> Linked issue number (or --explicit-issue/--expected-issue)',
    '  --project-id <id>             AO project id (default: AO_PROJECT_ID or orchestrator-pack)',
    '  --current-issue-file <path>   Optional live issue body for drift detection',
    '  --pr-body-file <path>',
    '  --explicit-issue <n>',
    '  --declaration-issue <n>',
    '  --expected-issue <n>',
    '  --pr-head-sha <sha>',
    '  --changed-paths-file <path>   Newline-separated PR-modified paths (required)',
    '  --timeout-ms <n>',
    '  --simulate-crash-before-first-row',
    '  --simulate-crash-after-row <n>',
    '  --force-producer-unreachable',
    '  --summary                     Emit reviewer-facing summary text',
    '  --json                        Emit JSON (default)',
  ].join('\n');
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {
    repoRoot: process.cwd(),
    manifestPath: DEFAULT_REVERIFY_MANIFEST_PATH,
    summary: false,
    json: true,
    projectId: resolveDefaultAoProjectId(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--repo-root':
        opts.repoRoot = argv[++i] ?? opts.repoRoot;
        break;
      case '--trusted-base-root':
        opts.trustedBaseRoot = argv[++i] ?? '';
        break;
      case '--review-target-root':
        opts.reviewTargetRoot = argv[++i] ?? '';
        break;
      case '--manifest-path':
        opts.manifestPath = argv[++i] ?? opts.manifestPath;
        break;
      case '--snapshot-file':
        opts.snapshotFile = argv[++i] ?? '';
        break;
      case '--bound-snapshot-pr-number':
        opts.boundSnapshotPrNumber = argv[++i] ?? '';
        break;
      case '--bound-snapshot-issue-number':
        opts.boundSnapshotIssueNumber = argv[++i] ?? '';
        break;
      case '--project-id':
        opts.projectId = argv[++i] ?? String(opts.projectId);
        break;
      case '--current-issue-file':
        opts.currentIssueFile = argv[++i] ?? '';
        break;
      case '--pr-body-file':
        opts.prBodyFile = argv[++i] ?? '';
        break;
      case '--explicit-issue':
        opts.explicitIssue = argv[++i] ?? '';
        break;
      case '--declaration-issue':
        opts.declarationIssue = argv[++i] ?? '';
        break;
      case '--expected-issue':
        opts.expectedIssue = argv[++i] ?? '';
        break;
      case '--pr-head-sha':
        opts.prHeadSha = argv[++i] ?? '';
        break;
      case '--changed-paths-file':
        opts.changedPathsFile = argv[++i] ?? '';
        break;
      case '--timeout-ms':
        opts.timeoutMs = argv[++i] ?? '';
        break;
      case '--simulate-crash-before-first-row':
        opts.simulateCrashBeforeFirstRow = true;
        break;
      case '--simulate-crash-after-row':
        opts.simulateCrashAfterRow = argv[++i] ?? '';
        break;
      case '--force-producer-unreachable':
        opts.forceProducerUnreachable = true;
        break;
      case '--summary':
        opts.summary = true;
        opts.json = false;
        break;
      default:
        if (!handleCliHelpOrJson(arg, usage(), () => {
          opts.json = true;
          opts.summary = false;
        })) {
          throwUnknownCliArg(arg, usage());
        }
        break;
    }
  }

  return opts;
}

function resolveBoundSnapshotIssueNumber(opts: Record<string, string | boolean>): number {
  if (opts.boundSnapshotIssueNumber) {
    return Number(opts.boundSnapshotIssueNumber);
  }
  if (opts.expectedIssue) {
    return Number(opts.expectedIssue);
  }
  if (opts.explicitIssue) {
    return Number(opts.explicitIssue);
  }
  return 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = String(opts.repoRoot);
  const trustedBaseRoot = String(opts.trustedBaseRoot || repoRoot);
  const reviewTargetRoot = String(opts.reviewTargetRoot || repoRoot);
  const snapshotFile = String(opts.snapshotFile ?? '');
  if (!snapshotFile) {
    console.error('missing required --snapshot-file');
    process.exit(2);
  }

  const changedPathsFile = String(opts.changedPathsFile ?? '');
  if (!changedPathsFile) {
    console.error('missing required --changed-paths-file');
    process.exit(2);
  }
  if (!existsSync(changedPathsFile)) {
    console.error(`changed paths file not found: ${changedPathsFile}`);
    process.exit(2);
  }

  const boundSnapshotPrNumber = Number(opts.boundSnapshotPrNumber ?? 0);
  if (!Number.isInteger(boundSnapshotPrNumber) || boundSnapshotPrNumber <= 0) {
    console.error('missing required --bound-snapshot-pr-number');
    process.exit(2);
  }

  const boundSnapshotIssueNumber = resolveBoundSnapshotIssueNumber(opts);
  if (!Number.isInteger(boundSnapshotIssueNumber) || boundSnapshotIssueNumber <= 0) {
    console.error('missing bound snapshot issue: --bound-snapshot-issue-number or --explicit-issue/--expected-issue');
    process.exit(2);
  }

  const prHeadSha = resolveHeadSha(opts.prHeadSha ? String(opts.prHeadSha) : undefined);
  if (!prHeadSha) {
    console.error('missing required --pr-head-sha for bound snapshot validation');
    process.exit(2);
  }
  let boundSnapshotBody: string;
  try {
    ({ body: boundSnapshotBody } = loadValidatedBoundSnapshotBody({
      projectId: String(opts.projectId),
      prNumber: boundSnapshotPrNumber,
      prHeadSha,
      issueNumber: boundSnapshotIssueNumber,
      snapshotFilePath: snapshotFile,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const prModifiedPaths = readLines(changedPathsFile);

  const result = runContractEvidenceReverify({
    repoRoot,
    trustedBaseRoot,
    reviewTargetRoot,
    manifestPath: String(opts.manifestPath),
    boundSnapshotBody,
    currentIssueBody: opts.currentIssueFile ? readText(String(opts.currentIssueFile)) : null,
    prBody: opts.prBodyFile ? readText(String(opts.prBodyFile)) : null,
    explicitIssueNumber: opts.explicitIssue ? Number(opts.explicitIssue) : null,
    declarationIssueNumber: opts.declarationIssue ? Number(opts.declarationIssue) : null,
    expectedIssueNumber: opts.expectedIssue ? Number(opts.expectedIssue) : null,
    prHeadSha,
    prModifiedPaths,
    timeoutMs: opts.timeoutMs ? Number(opts.timeoutMs) : undefined,
    simulateCrashBeforeFirstRow: Boolean(opts.simulateCrashBeforeFirstRow),
    simulateCrashAfterRow: opts.simulateCrashAfterRow
      ? Number(opts.simulateCrashAfterRow)
      : undefined,
    forceProducerUnreachable: Boolean(opts.forceProducerUnreachable),
  });

  if (opts.summary) {
    console.log(formatReviewerReverifySummary(result));
    process.exit(0);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  runReviewerTsCli(main);
}
