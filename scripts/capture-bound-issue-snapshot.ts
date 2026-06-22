#!/usr/bin/env node
import { readText } from './lib/reviewer-cli-io.js';
import {
  captureBoundIssueSnapshot,
  resolveDefaultAoProjectId,
} from './lib/reverify-bound-issue-snapshot.js';

function usage(): string {
  return [
    'Usage: capture-bound-issue-snapshot.ts [options]',
    '  --project-id <id>             AO project id (default: AO_PROJECT_ID or orchestrator-pack)',
    '  --pr-number <n>               PR number (required)',
    '  --pr-head-sha <sha>           PR head SHA (required)',
    '  --issue-number <n>            Linked issue number (required)',
    '  --issue-body-file <path>      Immutable issue body to capture (required)',
    '  --json                        Emit JSON (default)',
  ].join('\n');
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = { json: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--project-id':
        opts.projectId = argv[++i] ?? '';
        break;
      case '--pr-number':
        opts.prNumber = argv[++i] ?? '';
        break;
      case '--pr-head-sha':
        opts.prHeadSha = argv[++i] ?? '';
        break;
      case '--issue-number':
        opts.issueNumber = argv[++i] ?? '';
        break;
      case '--issue-body-file':
        opts.issueBodyFile = argv[++i] ?? '';
        break;
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        console.log(usage());
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const prNumber = Number(opts.prNumber);
  const issueNumber = Number(opts.issueNumber);
  const issueBodyFile = String(opts.issueBodyFile ?? '');
  const prHeadSha = String(opts.prHeadSha ?? '');
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('missing required --pr-number');
    process.exit(2);
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    console.error('missing required --issue-number');
    process.exit(2);
  }
  if (!prHeadSha) {
    console.error('missing required --pr-head-sha');
    process.exit(2);
  }
  if (!issueBodyFile) {
    console.error('missing required --issue-body-file');
    process.exit(2);
  }

  const result = captureBoundIssueSnapshot({
    projectId: String(opts.projectId || resolveDefaultAoProjectId()),
    prNumber,
    prHeadSha,
    issueNumber,
    issueBody: readText(issueBodyFile),
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.snapshotPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
