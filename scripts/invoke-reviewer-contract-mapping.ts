#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  buildStructuredStatusRecord,
  computeBoundDiffArtifactHash,
  countDiffLines,
  evaluateFinalUsability,
  evaluateMappingPreflight,
  finalizeMappingFromLedger,
  resolveStatusPrecedence,
  validateMappingLedger,
  sha256Hex,
  type ContractMappingStatus,
  type ContractMappingStatusRecord,
  type ContractSpecMember,
  type MappingLedger,
} from './lib/reviewer-contract-mapping.js';

interface CliOptions {
  prBodyFile: string | null;
  issueFile: string | null;
  issuesFile: string | null;
  issueSpecs: Array<{ issueNumber: number; filePath: string }>;
  diffFile: string | null;
  changedPathsFile: string | null;
  explicitIssue: number | null;
  declarationIssue: number | null;
  prHeadSha: string | null;
  ledgerFile: string | null;
  invokeCoworker: boolean;
  json: boolean;
  lookupAvailable: boolean;
  coworkerAvailable: boolean;
  providerInputByteLimit?: number;
  preflightOnly?: boolean;
}

export function parseIssueSpecAssignments(
  lines: string[],
): Array<{ issueNumber: number; filePath: string }> {
  const specs: Array<{ issueNumber: number; filePath: string }> = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^(\d+)\s*[=:]\s*(.+)$/);
    if (!match) {
      throw new Error(`invalid issue spec assignment line: ${line}`);
    }
    const issueNumber = Number(match[1]);
    const filePath = match[2]!.trim();
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !filePath) {
      throw new Error(`invalid issue spec assignment line: ${line}`);
    }
    specs.push({ issueNumber, filePath });
  }
  return specs;
}

export function parseLedgerPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('empty coworker ledger payload');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence?.[1]) {
      return JSON.parse(fence[1].trim());
    }
    throw new Error('coworker ledger payload is not valid JSON');
  }
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    prBodyFile: null,
    issueFile: null,
    issuesFile: null,
    issueSpecs: [],
    diffFile: null,
    changedPathsFile: null,
    explicitIssue: null,
    declarationIssue: null,
    prHeadSha: null,
    ledgerFile: null,
    invokeCoworker: false,
    json: true,
    lookupAvailable: true,
    coworkerAvailable: true,
    preflightOnly: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--pr-body-file') {
      opts.prBodyFile = argv[++i] ?? null;
    } else if (arg === '--issue-file') {
      opts.issueFile = argv[++i] ?? null;
    } else if (arg === '--issues-file') {
      opts.issuesFile = argv[++i] ?? null;
    } else if (arg === '--issue-spec') {
      const assignment = argv[++i] ?? '';
      const specs = parseIssueSpecAssignments([assignment]);
      opts.issueSpecs.push(...specs);
    } else if (arg === '--diff-file') {
      opts.diffFile = argv[++i] ?? null;
    } else if (arg === '--changed-paths-file') {
      opts.changedPathsFile = argv[++i] ?? null;
    } else if (arg === '--ledger-file') {
      opts.ledgerFile = argv[++i] ?? null;
    } else if (arg === '--invoke-coworker') {
      opts.invokeCoworker = true;
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
    } else if (arg === '--preflight-only') {
      opts.preflightOnly = true;
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
  --issue-file <path>           Single issue/spec body (legacy; pair with --explicit-issue or --declaration-issue)
  --issues-file <path>          Newline manifest of issueNumber=path bindings for multi-spec mapping
  --issue-spec <n>:<path>       Repeatable issueNumber=path binding (alternative to --issues-file)
  --pr-body-file <path>         PR body for closing-keyword binding
  --changed-paths-file <path>   Newline-delimited changed paths
  --ledger-file <path>          Coworker mapping JSON to validate and finalize mapped status
  --invoke-coworker             Run returned coworker argv and finalize mapped status from its JSON output
  --explicit-issue <n>          Authoritative issue from review context
  --declaration-issue <n>       Unique declaration/scope issue
  --pr-head-sha <sha>           PR head SHA for status binding
  --lookup-unavailable          Simulate issue lookup failure
  --coworker-unavailable        Simulate coworker missing
  --provider-input-byte-limit <n>  Provider/input ceiling for preflight
  --preflight-only              Stop after mapping preflight (fixture/integration smoke)
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

export function resolveLiveHeadSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function resolveHeadSha(explicit: string | null): string {
  if (explicit) {
    return explicit;
  }
  return resolveLiveHeadSha();
}

export type IssueBodyResolver = (issueNumber: number) => string;

export function fetchIssueBodyFromGitHub(
  issueNumber: number,
  repoRoot: string = process.cwd(),
): string {
  const ghArgs = ['issue', 'view', String(issueNumber), '--json', 'body'];
  const raw = execFileSync('gh', ghArgs, { encoding: 'utf8', cwd: repoRoot });
  const payload = JSON.parse(raw) as { body?: string };
  const body = payload.body;
  if (typeof body !== 'string') {
    throw new Error(`Freshness re-fetch: issue #${issueNumber} body unavailable from GitHub`);
  }
  return body;
}

export function createGitHubIssueBodyResolver(repoRoot?: string): IssueBodyResolver {
  const root = repoRoot ?? process.cwd();
  return (issueNumber) => fetchIssueBodyFromGitHub(issueNumber, root);
}

export function createLocalIssueBodyResolver(opts: CliOptions): IssueBodyResolver {
  const bodies = loadSpecBodiesFromOptions(opts);
  const bodyByIssue = new Map(bodies.map((spec) => [spec.issueNumber, spec.body] as const));
  return (issueNumber) => {
    const body = bodyByIssue.get(issueNumber);
    if (!body) {
      throw new Error(`missing spec body for issue #${issueNumber} on freshness re-read`);
    }
    return body;
  };
}

export function recomputeCurrentSpecHashesWithResolver(
  contractSet: Array<Pick<ContractSpecMember, 'issueNumber'>>,
  resolveIssueBody: IssueBodyResolver,
): Array<{ issueNumber: number; snapshotHash: string }> {
  return contractSet.map((member) => {
    const body = resolveIssueBody(member.issueNumber);
    return {
      issueNumber: member.issueNumber,
      snapshotHash: sha256Hex(body),
    };
  });
}

export function recomputeCurrentSpecHashes(
  opts: CliOptions,
  contractSet: Array<Pick<ContractSpecMember, 'issueNumber'>>,
): Array<{ issueNumber: number; snapshotHash: string }> {
  return recomputeCurrentSpecHashesWithResolver(
    contractSet,
    createLocalIssueBodyResolver(opts),
  );
}

export type SpecRereadOutcome =
  | { ok: true; hashes: Array<{ issueNumber: number; snapshotHash: string }> }
  | { ok: false; status: 'lookup_unavailable' | 'stale_spec' };

export function createSpecFreshnessResolver(_opts: CliOptions): IssueBodyResolver {
  return createGitHubIssueBodyResolver();
}

export function tryRecomputeCurrentSpecHashes(
  opts: CliOptions,
  contractSet: Array<Pick<ContractSpecMember, 'issueNumber' | 'snapshotHash'>>,
  resolveIssueBody: IssueBodyResolver = createGitHubIssueBodyResolver(),
): SpecRereadOutcome {
  try {
    const hashes = recomputeCurrentSpecHashesWithResolver(contractSet, resolveIssueBody);
    const hashByIssue = new Map(hashes.map((entry) => [entry.issueNumber, entry.snapshotHash] as const));
    for (const member of contractSet) {
      const currentHash = hashByIssue.get(member.issueNumber);
      if (!currentHash || currentHash !== member.snapshotHash) {
        return { ok: false, status: 'stale_spec' };
      }
    }
    return { ok: true, hashes };
  } catch {
    return { ok: false, status: 'lookup_unavailable' };
  }
}

export function buildSpecRereadFallbackOutput(input: {
  status: 'lookup_unavailable' | 'stale_spec';
  prHeadSha: string;
  contractSet: ContractSpecMember[];
  diffContent: string;
  preflightStatusRecord: ContractMappingStatusRecord;
}): {
  status: ContractMappingStatus;
  statusRecord: ContractMappingStatusRecord;
  ledger: undefined;
} {
  const statusRecord = buildStructuredStatusRecord({
    status: input.status,
    prHeadSha: input.prHeadSha,
    diffArtifactHash: computeBoundDiffArtifactHash(input.diffContent) ?? undefined,
    members: input.contractSet,
    staleDimensions: input.status === 'stale_spec' ? { spec: true } : undefined,
  });
  return {
    status: input.status,
    statusRecord,
    ledger: undefined,
  };
}

export function loadSpecBodiesFromOptions(opts: CliOptions): Array<{ issueNumber: number; body: string }> {
  const specBodies: Array<{ issueNumber: number; body: string }> = [];
  const assignments = [...opts.issueSpecs];

  if (opts.issuesFile) {
    assignments.push(...parseIssueSpecAssignments(readLines(opts.issuesFile)));
  }

  if (opts.issueFile) {
    const issueNumber = opts.explicitIssue ?? opts.declarationIssue ?? 0;
    if (!issueNumber) {
      throw new Error('--issue-file requires --explicit-issue or --declaration-issue');
    }
    assignments.push({ issueNumber, filePath: opts.issueFile });
  }

  const seen = new Set<number>();
  for (const assignment of assignments) {
    if (seen.has(assignment.issueNumber)) {
      throw new Error(`duplicate issue spec assignment for #${assignment.issueNumber}`);
    }
    seen.add(assignment.issueNumber);
    specBodies.push({
      issueNumber: assignment.issueNumber,
      body: readText(assignment.filePath),
    });
  }

  return specBodies;
}


export function resolveCoworkerLedgerInput(input: {
  invokeCoworker: boolean;
  coworkerArgv: string[] | null | undefined;
  ledgerRaw: string | null;
  invokeCoworkerArgvFn?: typeof invokeCoworkerArgv;
}): { ledgerPayload: unknown; coworkerInvocationFailed: boolean } {
  const invoke = input.invokeCoworkerArgvFn ?? invokeCoworkerArgv;
  let coworkerInvocationFailed = false;
  let ledgerPayload: unknown = null;

  if (input.invokeCoworker) {
    if (!input.coworkerArgv?.length) {
      throw new Error('missing coworker argv from preflight');
    }
    let rawOutput = '';
    try {
      rawOutput = invoke(input.coworkerArgv);
    } catch {
      return { ledgerPayload: null, coworkerInvocationFailed: true };
    }
    try {
      ledgerPayload = parseLedgerPayload(rawOutput);
    } catch {
      ledgerPayload = null;
    }
    return { ledgerPayload, coworkerInvocationFailed: false };
  }

  if (input.ledgerRaw !== null) {
    try {
      ledgerPayload = parseLedgerPayload(input.ledgerRaw);
    } catch {
      ledgerPayload = null;
    }
  }
  return { ledgerPayload, coworkerInvocationFailed: false };
}

export function invokeCoworkerArgv(argv: string[]): string {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error('missing coworker command');
  }
  return execFileSync(command, args, { encoding: 'utf8' });
}


export function shouldInvokeCoworkerForStatus(status: ContractMappingStatus): boolean {
  return status === 'mapping_pending';
}

export function mergeSpecRereadFailure(input: {
  status: ContractMappingStatus;
  statusRecord: ContractMappingStatusRecord;
  ledger?: MappingLedger;
  fallback: ReturnType<typeof buildSpecRereadFallbackOutput>;
  specRereadStatus: 'lookup_unavailable' | 'stale_spec';
}): {
  status: ContractMappingStatus;
  statusRecord: ContractMappingStatusRecord;
  ledger?: MappingLedger;
} {
  const resolvedStatus = resolveStatusPrecedence([input.status, input.fallback.status]);
  if (resolvedStatus === input.fallback.status) {
    return {
      status: input.fallback.status,
      statusRecord: input.fallback.statusRecord,
      ledger: input.fallback.ledger,
    };
  }
  if (input.specRereadStatus === 'stale_spec') {
    return {
      status: input.status,
      statusRecord: {
        ...input.statusRecord,
        staleDimensions: {
          ...input.statusRecord.staleDimensions,
          head: input.statusRecord.staleDimensions?.head ?? input.status === 'stale_head',
          spec: true,
        },
      },
      ledger: undefined,
    };
  }
  return {
    status: input.status,
    statusRecord: input.statusRecord,
    ledger: input.ledger,
  };
}

export function applyMappedOutputFinalUsability(input: {
  status: ContractMappingStatus;
  statusRecord: ContractMappingStatusRecord;
  ledger?: MappingLedger;
  currentHeadSha: string;
  diffContent: string;
  currentSpecHashes: Array<{ issueNumber: number; snapshotHash: string }>;
}): {
  status: ContractMappingStatus;
  statusRecord: ContractMappingStatusRecord;
  ledger?: MappingLedger;
} {
  if (input.status !== 'mapped') {
    return {
      status: input.status,
      statusRecord: input.statusRecord,
      ledger: input.ledger,
    };
  }

  const final = evaluateFinalUsability({
    prior: input.statusRecord,
    currentHeadSha: input.currentHeadSha,
    currentDiffArtifactHash: computeBoundDiffArtifactHash(input.diffContent) ?? undefined,
    currentSpecHashes: input.currentSpecHashes,
  });

  if (final.status !== 'mapped') {
    return {
      status: final.status,
      statusRecord: final,
      ledger: undefined,
    };
  }

  return {
    status: input.status,
    statusRecord: final,
    ledger: input.ledger,
  };
}

function main(): void {
  const opts = parseArgs(process.argv);
  if (!opts.diffFile) {
    console.error('missing required --diff-file');
    process.exit(2);
  }
  if (opts.ledgerFile && opts.invokeCoworker) {
    console.error('use only one of --ledger-file or --invoke-coworker');
    process.exit(2);
  }

  const diffContent = readText(opts.diffFile);
  const diffLineCount = countDiffLines(diffContent);
  const prHeadSha = resolveHeadSha(opts.prHeadSha);
  const changedPaths = opts.changedPathsFile ? readLines(opts.changedPathsFile) : [];

  let specBodies: Array<{ issueNumber: number; body: string }> = [];
  try {
    specBodies = loadSpecBodiesFromOptions(opts);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const preflight = evaluateMappingPreflight({
    diffLineCount,
    diffContent,
    prHeadSha,
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

  if (opts.preflightOnly) {
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
      ledger: null,
    };
    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`status=${output.status} invoke=${output.shouldInvokeCoworker}`);
      console.log(`head=${output.statusRecord.prHeadSha}`);
    }
    process.exit(0);
  }

  let status = preflight.status;
  let statusRecord = preflight.statusRecord;
  let ledger: MappingLedger | undefined;

  if (opts.ledgerFile || opts.invokeCoworker) {
    if (!preflight.shouldInvokeCoworker || preflight.status !== 'mapping_pending') {
      console.error('cannot finalize mapping: preflight did not reach mapping_pending');
      process.exit(2);
    }

    let coworkerInvocationFailed = false;
    let ledgerPayload: unknown = null;
    try {
      const resolved = resolveCoworkerLedgerInput({
        invokeCoworker: opts.invokeCoworker,
        coworkerArgv: preflight.coworkerArgv,
        ledgerRaw: opts.ledgerFile ? readText(opts.ledgerFile) : null,
      });
      coworkerInvocationFailed = resolved.coworkerInvocationFailed;
      ledgerPayload = resolved.ledgerPayload;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    }

    const currentHeadShaAfterCoworker = resolveLiveHeadSha();
    const finalized = finalizeMappingFromLedger({
      preflight,
      ledgerPayload,
      diffContent,
      currentHeadSha: currentHeadShaAfterCoworker,
      coworkerInvocationFailed,
    });
    status = finalized.status;
    statusRecord = finalized.statusRecord;
    ledger = finalized.ledger;
  }

  const currentHeadSha = resolveLiveHeadSha();
  let currentSpecHashes = preflight.contractSet.map((member) => ({
    issueNumber: member.issueNumber,
    snapshotHash: member.snapshotHash,
  }));
  if (preflight.contractSet.length > 0) {
    const specReread = tryRecomputeCurrentSpecHashes(
      opts,
      preflight.contractSet,
      createSpecFreshnessResolver(opts),
    );
    if (!specReread.ok) {
      const fallback = buildSpecRereadFallbackOutput({
        status: specReread.status,
        prHeadSha: currentHeadSha,
        contractSet: preflight.contractSet,
        diffContent,
        preflightStatusRecord: statusRecord,
      });
      const merged = mergeSpecRereadFailure({
        status,
        statusRecord,
        ledger,
        fallback,
        specRereadStatus: specReread.status,
      });
      status = merged.status;
      statusRecord = merged.statusRecord;
      ledger = merged.ledger;
    } else {
      currentSpecHashes = specReread.hashes;
    }
  }
  if (status !== 'lookup_unavailable' && status !== 'stale_spec') {
    const finalizedOutput = applyMappedOutputFinalUsability({
      status,
      statusRecord,
      ledger,
      currentHeadSha,
      diffContent,
      currentSpecHashes,
    });
    status = finalizedOutput.status;
    statusRecord = finalizedOutput.statusRecord;
    ledger = finalizedOutput.ledger;
  }

  const output = {
    status,
    shouldInvokeCoworker: shouldInvokeCoworkerForStatus(status),
    statusRecord,
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
    ledger: ledger ?? null,
  };

  if (opts.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`status=${output.status} invoke=${output.shouldInvokeCoworker}`);
    console.log(`head=${output.statusRecord.prHeadSha}`);
  }

  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export function validateLedgerFromStdin(
  ledger: MappingLedger,
  members: Parameters<typeof validateMappingLedger>[1],
  context?: Parameters<typeof validateMappingLedger>[2],
) {
  return validateMappingLedger(ledger, members, context);
}
