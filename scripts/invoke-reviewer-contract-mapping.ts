#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  evaluateFinalUsability,
  evaluateMappingPreflight,
  validateMappingLedger,
  type MappingLedger,
} from './lib/reviewer-contract-mapping.js';

interface CliOptions {
  prBodyFile: string | null;
  issueFile: string | null;
  diffFile: string | null;
  changedPathsFile: string | null;
  explicitIssue: number | null;
  declarationIssue: number | null;
  prHeadSha: string | null;
  json: boolean;
  lookupAvailable: boolean;
  coworkerAvailable: boolean;
  providerInputByteLimit?: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    prBodyFile: null,
    issueFile: null,
    diffFile: null,
    changedPathsFile: null,
    explicitIssue: null,
    declarationIssue: null,
    prHeadSha: null,
    json: true,
    lookupAvailable: true,
    coworkerAvailable: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--pr-body-file') {
      opts.prBodyFile = argv[++i] ?? null;
    } else if (arg === '--issue-file') {
      opts.issueFile = argv[++i] ?? null;
    } else if (arg === '--diff-file') {
      opts.diffFile = argv[++i] ?? null;
    } else if (arg === '--changed-paths-file') {
      opts.changedPathsFile = argv[++i] ?? null;
    } else if (arg === '--explicit-issue') {
      opts.explicitIssue = Number(argv[++i]);
    } else if (arg === '--declaration-issue') {
      opts.declarationIssue = Number(argv[++i]);
    } else if (arg === '--pr-head-sha') {
      opts.prHeadSha = argv[++i] ?? null;
    } else if (arg === '--lookup-unavailable') {
      opts.lookupAvailable = false;
    } else if (arg === '--coworker-unavailable') {
      opts.coworkerAvailable = false;
    } else if (arg === '--provider-input-byte-limit') {
      opts.providerInputByteLimit = Number(argv[++i]);
    } else if (arg === '--text') {
      opts.json = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`Usage: invoke-reviewer-contract-mapping.ts [options]

Options:
  --diff-file <path>            PR diff file (required)
  --issue-file <path>           Issue/spec body with contract sections
  --pr-body-file <path>         PR body for closing-keyword binding
  --changed-paths-file <path>   Newline-delimited changed paths
  --explicit-issue <n>          Authoritative issue from review context
  --declaration-issue <n>       Unique declaration/scope issue
  --pr-head-sha <sha>           PR head SHA for status binding
  --lookup-unavailable          Simulate issue lookup failure
  --coworker-unavailable        Simulate coworker missing
  --provider-input-byte-limit <n>  Provider/input ceiling for preflight
  --text                        Human-readable output instead of JSON
`);
}

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function readLines(filePath: string): string[] {
  return readText(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveHeadSha(explicit: string | null): string {
  if (explicit) {
    return explicit;
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function main(): void {
  const opts = parseArgs(process.argv);
  if (!opts.diffFile) {
    console.error('missing required --diff-file');
    process.exit(2);
  }

  const diffContent = readText(opts.diffFile);
  const diffLineCount = diffContent.split(/\r?\n/).length;
  const changedPaths = opts.changedPathsFile ? readLines(opts.changedPathsFile) : [];

  const specBodies = [];
  if (opts.issueFile) {
    const body = readText(opts.issueFile);
    const issueNumber = opts.explicitIssue ?? opts.declarationIssue ?? 0;
    if (!issueNumber) {
      console.error('--issue-file requires --explicit-issue or --declaration-issue');
      process.exit(2);
    }
    specBodies.push({ issueNumber, body });
  }

  const preflight = evaluateMappingPreflight({
    diffLineCount,
    diffContent,
    changedPaths,
    binding: {
      explicitIssueNumber: opts.explicitIssue,
      prBody: opts.prBodyFile ? readText(opts.prBodyFile) : null,
      declarationIssueNumber: opts.declarationIssue,
    },
    specBodies,
    providerInputByteLimit: opts.providerInputByteLimit,
    lookupAvailable: opts.lookupAvailable,
    coworkerAvailable: opts.coworkerAvailable,
  });

  const prHeadSha = resolveHeadSha(opts.prHeadSha);
  preflight.statusRecord.prHeadSha = prHeadSha;

  const output = {
    status: preflight.status,
    shouldInvokeCoworker: preflight.shouldInvokeCoworker,
    statusRecord: preflight.statusRecord,
    contractSet: preflight.contractSet.map((member) => ({
      issueNumber: member.issueNumber,
      snapshotHash: member.snapshotHash,
      acceptanceCriteriaCount: member.acceptanceCriteria.length,
    })),
    artifactPrep: preflight.artifactPrep
      ? {
          artifactDir: preflight.artifactPrep.artifactDir,
          diffPath: preflight.artifactPrep.diffPath,
          specPaths: preflight.artifactPrep.specPaths,
          diffArtifactHash: preflight.artifactPrep.diffArtifactHash,
          specArtifactHashes: preflight.artifactPrep.specArtifactHashes,
          combinedByteSize: preflight.artifactPrep.combinedByteSize,
        }
      : null,
    coworkerArgv: preflight.coworkerArgv ?? null,
  };

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`status=${output.status} invoke=${output.shouldInvokeCoworker}`);
    console.log(`head=${output.statusRecord.prHeadSha}`);
  }

  if (preflight.status === 'mapped') {
    const final = evaluateFinalUsability({
      prior: preflight.statusRecord,
      currentHeadSha: prHeadSha,
      currentSpecHashes: preflight.contractSet.map((member) => ({
        issueNumber: member.issueNumber,
        snapshotHash: member.snapshotHash,
      })),
    });
    if (final.status !== preflight.status) {
      process.exit(1);
    }
  }

  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export function validateLedgerFromStdin(
  ledger: MappingLedger,
  members: Parameters<typeof validateMappingLedger>[1],
) {
  return validateMappingLedger(ledger, members);
}
