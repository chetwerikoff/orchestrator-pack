#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { defaultGhTransport } from './lib/create-issue-stage-record-gh.ts';
import { runFinalAcceptance } from './lib/create-issue-final-acceptance.ts';
import type { PublicActor } from './lib/create-issue-stage-record-types.ts';
import {
  bootstrapReviewerCli,
  finalizeReviewerArgvIndex,
  parseRequiredNonEmptyString,
  parseRequiredPositiveInt,
  runReviewerParsedCli,
} from './lib/reviewer-ts-cli.ts';

interface CliOptions {
  repo: string;
  issueNumber: number;
  cycleId: string;
  issueBodyPath: string;
  issueRevision: string;
  reviewDir: string;
  stageReceipts: string[];
  capturePaths: string[];
  ledgerPath?: string;
  relayEvidencePaths: string[];
  claudeProducerEvidencePaths: string[];
  externalPassReceiptPath?: string;
  publicActor: PublicActor;
  workdir?: string;
  json: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  create-issue-final-acceptance.ts --repo <owner/name> --issue-number <n> --cycle-id <id> --issue-body <path> --issue-revision <rNN> --review-dir <path> --stage-receipt <path>... [--capture <path>...] [--ledger <path>] [--relay-evidence <path>...] [--claude-producer-evidence <path>...] [--external-pass-receipt <path>] [--public-actor <actor>] [--workdir <path>] [--json]',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    repo: 'chetwerikoff/orchestrator-pack',
    issueNumber: 0,
    cycleId: '',
    issueBodyPath: '',
    issueRevision: '',
    reviewDir: '',
    stageReceipts: [],
    capturePaths: [],
    relayEvidencePaths: [],
    claudeProducerEvidencePaths: [],
    publicActor: 'cursor-flow-manager',
    json: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--repo':
        opts.repo = String(argv[++i] ?? opts.repo);
        break;
      case '--issue-number':
        opts.issueNumber = Number(argv[++i]);
        break;
      case '--cycle-id':
        opts.cycleId = String(argv[++i] ?? '');
        break;
      case '--issue-body':
        opts.issueBodyPath = String(argv[++i] ?? '');
        break;
      case '--issue-revision':
        opts.issueRevision = String(argv[++i] ?? '');
        break;
      case '--review-dir':
        opts.reviewDir = String(argv[++i] ?? '');
        break;
      case '--stage-receipt':
        opts.stageReceipts.push(String(argv[++i] ?? ''));
        break;
      case '--capture':
        opts.capturePaths.push(String(argv[++i] ?? ''));
        break;
      case '--ledger':
        opts.ledgerPath = String(argv[++i] ?? '');
        break;
      case '--relay-evidence':
        opts.relayEvidencePaths.push(String(argv[++i] ?? ''));
        break;
      case '--claude-producer-evidence':
        opts.claudeProducerEvidencePaths.push(String(argv[++i] ?? ''));
        break;
      case '--external-pass-receipt':
        opts.externalPassReceiptPath = String(argv[++i] ?? '');
        break;
      default:
        i = finalizeReviewerArgvIndex(arg, argv, i, opts, usage());
        break;
    }
  }
  return opts;
}

export function runCli(argv: string[]): number {
  return runReviewerParsedCli(argv, 'create-issue-final-acceptance', parseArgs, (opts) => {
  const issueNumber = parseRequiredPositiveInt(String(opts.issueNumber || ''), '--issue-number');
  const cycleId = parseRequiredNonEmptyString(opts.cycleId, '--cycle-id');
  const issueBodyPath = parseRequiredNonEmptyString(opts.issueBodyPath, '--issue-body');
  const issueRevision = parseRequiredNonEmptyString(opts.issueRevision, '--issue-revision');
  const reviewDir = parseRequiredNonEmptyString(opts.reviewDir, '--review-dir');
  if (opts.stageReceipts.length === 0) {
    process.stderr.write('create-issue-final-acceptance: at least one --stage-receipt is required\n');
    return 2;
  }

  const issueBody = readFileSync(issueBodyPath, 'utf8');
  const transport = defaultGhTransport();
  const result = runFinalAcceptance(transport, {
    repo: opts.repo,
    issueNumber,
    cycleId,
    issueBody,
    issueRevision,
    reviewDir,
    stageReceiptPaths: opts.stageReceipts,
    capturePaths: opts.capturePaths,
    ledgerPath: opts.ledgerPath,
    relayEvidencePaths: opts.relayEvidencePaths,
    claudeProducerEvidencePaths: opts.claudeProducerEvidencePaths,
    externalPassReceiptPath: opts.externalPassReceiptPath,
    publicActor: opts.publicActor,
    workdir: opts.workdir,
  });

  if (opts.json) console.log(JSON.stringify(result));
  else if (!result.ok) {
    for (const error of result.guardErrors) process.stderr.write(`${error}\n`);
    for (const diagnostic of result.diagnostics) process.stderr.write(`${diagnostic.message}\n`);
  }
  return result.ok ? 0 : 1;
  });
}

bootstrapReviewerCli(import.meta.url, process.argv[1], runCli);
