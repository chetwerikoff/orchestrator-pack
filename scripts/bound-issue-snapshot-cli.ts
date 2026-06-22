#!/usr/bin/env node
import { readText } from './lib/reviewer-cli-io.js';
import {
  isDirectCliExecution,
  parseRequiredNonEmptyString,
  parseRequiredPositiveInt,
  runReviewerTsCli,
} from './lib/reviewer-ts-cli.js';
import {
  captureBoundIssueSnapshot,
  resolveBoundIssueSnapshot,
  resolveDefaultAoProjectId,
} from './lib/reverify-bound-issue-snapshot.js';

type Mode = 'capture' | 'resolve';

interface SharedOptions {
  mode: Mode;
  projectId: string;
  prNumber: number;
  prHeadSha: string;
  issueNumber: number;
  json: boolean;
  issueBodyFile?: string;
  require: boolean;
  pathOnly: boolean;
}

function usage(mode: Mode): string {
  const common = [
    '  --project-id <id>             AO project id (default: AO_PROJECT_ID or orchestrator-pack)',
    '  --pr-number <n>               PR number (required)',
    '  --pr-head-sha <sha>           PR head SHA (required)',
    '  --issue-number <n>            Linked issue number (required)',
  ];
  if (mode === 'capture') {
    return [
      'Usage: bound-issue-snapshot-cli.ts capture [options]',
      ...common,
      '  --issue-body-file <path>      Immutable issue body to capture (required)',
      '  --json                        Emit JSON (default)',
    ].join('\n');
  }
  return [
    'Usage: bound-issue-snapshot-cli.ts resolve [options]',
    ...common,
    '  --require                       Exit 2 when snapshot is missing',
    '  --json                          Emit JSON (default)',
    '  --path-only                     Print snapshot path when found',
  ].join('\n');
}

function parseArgs(argv: string[]): SharedOptions {
  const modeToken = argv[2];
  if (modeToken !== 'capture' && modeToken !== 'resolve') {
    throw new Error(`first argument must be capture or resolve\n${usage('resolve')}`);
  }
  const mode = modeToken;
  const opts: SharedOptions = {
    mode,
    projectId: resolveDefaultAoProjectId(),
    prNumber: 0,
    prHeadSha: '',
    issueNumber: 0,
    json: true,
    require: false,
    pathOnly: false,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--project-id':
        opts.projectId = String(argv[++i] ?? opts.projectId);
        break;
      case '--pr-number':
        opts.prNumber = Number(argv[++i]);
        break;
      case '--pr-head-sha':
        opts.prHeadSha = String(argv[++i] ?? '');
        break;
      case '--issue-number':
        opts.issueNumber = Number(argv[++i]);
        break;
      case '--issue-body-file':
        opts.issueBodyFile = String(argv[++i] ?? '');
        break;
      case '--require':
        opts.require = true;
        break;
      case '--path-only':
        opts.pathOnly = true;
        opts.json = false;
        break;
      case '--json':
        opts.json = true;
        opts.pathOnly = false;
        break;
      case '--help':
      case '-h':
        console.log(usage(mode));
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n${usage(mode)}`);
    }
  }

  return opts;
}

function runCapture(opts: SharedOptions): void {
  const prNumber = parseRequiredPositiveInt(String(opts.prNumber || ''), '--pr-number');
  const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
  const prHeadSha = parseRequiredNonEmptyString(opts.prHeadSha, '--pr-head-sha');
  const issueBodyFile = parseRequiredNonEmptyString(opts.issueBodyFile, '--issue-body-file');

  const result = captureBoundIssueSnapshot({
    projectId: opts.projectId,
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

function runResolve(opts: SharedOptions): void {
  const prNumber = parseRequiredPositiveInt(String(opts.prNumber || ''), '--pr-number');
  const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
  const prHeadSha = parseRequiredNonEmptyString(opts.prHeadSha, '--pr-head-sha');

  const result = resolveBoundIssueSnapshot({
    projectId: opts.projectId,
    prNumber,
    prHeadSha,
    issueNumber,
  });

  if (result.status === 'missing' && opts.require) {
    console.error(
      `bound issue snapshot missing for PR #${prNumber} head ${prHeadSha} issue #${issueNumber}`,
    );
    process.exit(2);
  }

  if (opts.pathOnly) {
    if (result.snapshotPath) {
      console.log(result.snapshotPath);
      return;
    }
    process.exit(opts.require ? 2 : 0);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result.snapshotPath ?? '');
}

function main(): void {
  const opts = parseArgs(process.argv);
  if (opts.mode === 'capture') {
    runCapture(opts);
    return;
  }
  runResolve(opts);
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  runReviewerTsCli(main);
}
