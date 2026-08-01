#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  defaultGhTransport,
} from './lib/create-issue-stage-record-gh.ts';
import {
  publishSettledStageRecord,
  retryPendingEvents,
  startReviewCycle,
} from './lib/create-issue-stage-record-core.ts';
import type { PublicActor } from './lib/create-issue-stage-record-types.ts';
import {
  bootstrapReviewerCli,
  finalizeReviewerArgvIndex,
  parseRequiredNonEmptyString,
  parseRequiredPositiveInt,
  runReviewerParsedCli,
} from './lib/reviewer-ts-cli.ts';

interface CliOptions {
  command: 'start-cycle' | 'publish-stage' | 'retry-pending';
  repo: string;
  issueNumber: number;
  sourceRevision?: string;
  tier?: string;
  publicActor: PublicActor;
  predecessorCycleId?: string;
  receiptPath?: string;
  waiverPath?: string;
  workdir?: string;
  json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  create-issue-stage-finalize.ts start-cycle --repo <owner/name> --issue-number <n> --source-revision <rNN> --tier <T1|T2|T3> [--public-actor <actor>] [--predecessor-cycle-id <id>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts publish-stage --repo <owner/name> --issue-number <n> --receipt <path> [--waiver <path>] [--workdir <path>] [--json]',
    '  create-issue-stage-finalize.ts retry-pending --repo <owner/name> --issue-number <n> [--workdir <path>] [--json]',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[2];
  if (command !== 'start-cycle' && command !== 'publish-stage' && command !== 'retry-pending') {
    throw new Error(`unknown command\n${usage()}`);
  }
  const opts: CliOptions = {
    command,
    repo: 'chetwerikoff/orchestrator-pack',
    issueNumber: 0,
    publicActor: 'cursor-flow-manager',
    json: false,
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--repo':
        opts.repo = String(argv[++i] ?? opts.repo);
        break;
      case '--issue-number':
        opts.issueNumber = Number(argv[++i]);
        break;
      case '--source-revision':
        opts.sourceRevision = String(argv[++i] ?? '');
        break;
      case '--tier':
        opts.tier = String(argv[++i] ?? '');
        break;
      case '--predecessor-cycle-id':
        opts.predecessorCycleId = String(argv[++i] ?? '');
        break;
      case '--receipt':
        opts.receiptPath = String(argv[++i] ?? '');
        break;
      case '--waiver':
        opts.waiverPath = String(argv[++i] ?? '');
        break;
      default:
        i = finalizeReviewerArgvIndex(arg, argv, i, opts, usage());
        break;
    }
  }
  return opts;
}

export function runCli(argv: string[]): number {
  return runReviewerParsedCli(argv, 'create-issue-stage-finalize', parseArgs, (opts) => {
  const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
  const transport = defaultGhTransport();

  if (opts.command === 'start-cycle') {
    const sourceRevision = parseRequiredNonEmptyString(opts.sourceRevision, '--source-revision');
    const tier = parseRequiredNonEmptyString(opts.tier, '--tier');
    const result = startReviewCycle(transport, {
      repo: opts.repo,
      issueNumber,
      sourceRevision,
      tier,
      publicActor: opts.publicActor,
      predecessorCycleId: opts.predecessorCycleId,
      workdir: opts.workdir,
    });
    if (opts.json) console.log(JSON.stringify(result));
    else if (!result.ok) process.stderr.write(`${result.diagnostics.map((item) => item.message).join('\n')}\n`);
    return result.ok ? 0 : 1;
  }

  if (opts.command === 'publish-stage') {
    const receiptPath = parseRequiredNonEmptyString(opts.receiptPath, '--receipt');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const result = publishSettledStageRecord(transport, {
      repo: opts.repo,
      issueNumber,
      receipt,
      waiverPath: opts.waiverPath,
      readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
      workdir: opts.workdir,
    });
    if (opts.json) console.log(JSON.stringify(result));
    else if (!result.ok) process.stderr.write(`${result.diagnostics.map((item) => item.message).join('\n')}\n`);
    return result.ok ? 0 : 1;
  }

  const results = retryPendingEvents(transport, opts.repo, issueNumber, opts.workdir);
  const ok = results.every((item) => item.ok);
  if (opts.json) console.log(JSON.stringify(results));
  return ok ? 0 : 1;
  });
}

bootstrapReviewerCli(import.meta.url, process.argv[1], runCli);
