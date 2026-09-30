#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessSync, type ProcessResult } from './kernel/subprocess.ts';
import { evaluateCreateIssueManagerBoundary } from './lib/create-issue-next-action.ts';
import {
  EXECUTE_ISSUE_PHASES,
  classifyExecuteIssueManagerRecord,
  type ExecuteIssueManagerBoundaryContext,
  type ExecuteIssuePhase,
} from './lib/execute-issue-manager-boundary.ts';

type Writer = { write: (chunk: string) => unknown };
interface CliDependencies {
  stdout?: Writer;
  stderr?: Writer;
  readFile?: (path: string) => string;
  currentArgv?: readonly string[];
  runGitHubRead?: (args: readonly string[]) => ProcessResult;
}
interface ParsedCli { recordPath: string; context: ExecuteIssueManagerBoundaryContext; }
interface ParsedWorkerSmokeObservationCli {
  repository: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  sourceRevision: string;
  phase: 'independent-smoke';
  cause: 'trusted_target_stale';
}

function usage(): string {
  return [
    'Execute-Issue manager result boundary', '', 'Usage:',
    '  node --experimental-strip-types scripts/execute-issue-manager-boundary.ts classify',
    '    --record <path> --repo <owner/repo> --issue-number <n> --source-revision <rNN>',
    '    --phase <implementation|review|fixer|independent-smoke> --production-argv-json <json> [--cdp <url>]',
    '    [--target-id <id> | --conversation-url <url>] [--profile <key> --invocation-id <id>] [--pr-number <n> --head-sha <40-hex>]',
    '  node --experimental-strip-types scripts/execute-issue-manager-boundary.ts observe-worker-smoke-recoverable',
    '    --repo <owner/repo> --issue-number <n> --pr-number <n> --head-sha <40-hex>',
    '    --source-revision <rNN> --phase independent-smoke --cause <recoverable-cause>',
    'This classifier emits only the shared four-outcome manager result contract.',
    'The recoverable observer performs only exact-target GitHub reads.',
    'Every nextAction.argv introduced here is read-only observation/reconciliation.',
  ].join('\n');
}
function positiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error(name + ' must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(name + ' must be a safe positive integer');
  return parsed;
}
function parsePhase(value: string | undefined): ExecuteIssuePhase {
  if (!value || !EXECUTE_ISSUE_PHASES.includes(value as ExecuteIssuePhase)) throw new Error('--phase must be one of ' + EXECUTE_ISSUE_PHASES.join(', '));
  return value as ExecuteIssuePhase;
}
function parseProductionArgv(value: string | undefined): readonly string[] {
  if (!value) throw new Error('--production-argv-json is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--production-argv-json must be a non-empty JSON array of non-empty strings');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error('--production-argv-json must be a non-empty JSON array of non-empty strings');
  }
  return parsed;
}
function parseWorkerSmokeObservationCli(argv: readonly string[]): ParsedWorkerSmokeObservationCli {
  if (argv[0] !== 'observe-worker-smoke-recoverable') {
    throw new Error('expected observe-worker-smoke-recoverable subcommand\n' + usage());
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('invalid observer option shape\n' + usage());
    }
    if (values.has(key)) throw new Error('duplicate option ' + key);
    values.set(key, value);
  }
  const allowed = new Set([
    '--repo', '--issue-number', '--pr-number', '--head-sha',
    '--source-revision', '--phase', '--cause',
  ]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error('unknown option ' + key);
  const repository = values.get('--repo');
  const sourceRevision = values.get('--source-revision');
  const headSha = values.get('--head-sha')?.toLowerCase();
  const phase = values.get('--phase');
  const cause = values.get('--cause');
  if (!repository || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('--repo must be owner/name');
  if (!sourceRevision || !/^r[0-9]+$/iu.test(sourceRevision)) throw new Error('--source-revision must be rNN');
  if (!headSha || !/^[0-9a-f]{40}$/u.test(headSha)) throw new Error('--head-sha must be a 40-character hexadecimal SHA');
  if (phase !== 'independent-smoke') throw new Error('--phase must be independent-smoke for worker-smoke recovery observation');
  if (cause !== 'trusted_target_stale') {
    throw new Error('--cause is outside the closed recoverable worker-smoke vocabulary');
  }
  return {
    repository,
    issueNumber: positiveInteger(values.get('--issue-number'), '--issue-number'),
    prNumber: positiveInteger(values.get('--pr-number'), '--pr-number'),
    headSha,
    sourceRevision,
    phase,
    cause,
  };
}

function parseCli(argv: readonly string[]): ParsedCli {
  if (argv[0] !== 'classify') throw new Error('expected classify subcommand\n' + usage());
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('invalid option shape\n' + usage());
    if (values.has(key)) throw new Error('duplicate option ' + key);
    values.set(key, value);
  }
  const allowed = new Set(['--record', '--repo', '--issue-number', '--source-revision', '--phase', '--production-argv-json', '--cdp', '--target-id', '--conversation-url', '--profile', '--invocation-id', '--pr-number', '--head-sha']);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error('unknown option ' + key);
  const recordPath = values.get('--record');
  const repository = values.get('--repo');
  const sourceRevision = values.get('--source-revision');
  if (!recordPath) throw new Error('--record is required');
  if (!repository || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error('--repo must be owner/name');
  if (!sourceRevision || !/^r[0-9]+$/iu.test(sourceRevision)) throw new Error('--source-revision must be rNN');
  const targetId = values.get('--target-id');
  const conversationUrl = values.get('--conversation-url');
  if (targetId && conversationUrl) throw new Error('provide at most one of --target-id or --conversation-url');
  const profile = values.get('--profile');
  const invocationId = values.get('--invocation-id');
  const hasProfile = values.has('--profile');
  const hasInvocationId = values.has('--invocation-id');
  if (hasProfile !== hasInvocationId) throw new Error('--profile and --invocation-id must be supplied together');
  if (hasProfile && (!profile || !invocationId)) throw new Error('--profile and --invocation-id must be non-empty when supplied');
  const prRaw = values.get('--pr-number');
  const phase = parsePhase(values.get('--phase'));
  const headSha = values.get('--head-sha')?.toLowerCase();
  if (headSha !== undefined && !/^[0-9a-f]{40}$/u.test(headSha)) throw new Error('--head-sha must be a 40-character hexadecimal SHA');
  if (phase === 'independent-smoke' && (!prRaw || !headSha)) throw new Error('--phase independent-smoke requires --pr-number and --head-sha');
  return {
    recordPath,
    context: {
      repository,
      issueNumber: positiveInteger(values.get('--issue-number'), '--issue-number'),
      sourceRevision,
      phase,
      productionArgv: parseProductionArgv(values.get('--production-argv-json')),
      ...(values.get('--cdp') ? { cdp: values.get('--cdp') } : {}),
      ...(targetId ? { targetId } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(profile !== undefined ? { profile } : {}),
      ...(invocationId !== undefined ? { invocationId } : {}),
      ...(prRaw ? { prNumber: positiveInteger(prRaw, '--pr-number') } : {}),
      ...(headSha ? { headSha } : {}),
    },
  };
}
function defectFromCliError(error: unknown, currentArgv: readonly string[]) {
  return evaluateCreateIssueManagerBoundary({
    producer: 'execute-issue-manager-boundary.ts:cli', currentArgv,
    produce: () => { throw error instanceof Error ? error : new Error(String(error)); },
  });
}
function parseGitHubReadJson(result: ProcessResult, label: string): Record<string, unknown> {
  if (!result.ok) {
    throw new Error(label + ' failed: ' + (result.stderr || result.error || String(result.exitCode ?? 'unknown')));
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(label + ' returned a non-object JSON payload');
  }
  return parsed as Record<string, unknown>;
}

function runWorkerSmokeRecoverableObservation(
  parsed: ParsedWorkerSmokeObservationCli,
  dependencies: CliDependencies,
): number {
  const stdout = dependencies.stdout ?? process.stdout;
  const runGitHubRead = dependencies.runGitHubRead ?? ((args: readonly string[]) => runProcessSync({
    command: 'scripts/gh',
    args,
    cwd: process.cwd(),
    inheritParentEnv: true,
    timeoutMs: 30_000,
  }));
  const prFields = 'number,headRefOid,body';
  const pr = parseGitHubReadJson(runGitHubRead([
    'pr', 'view', String(parsed.prNumber), '--repo', parsed.repository, '--json', prFields,
  ]), 'worker-smoke PR observation');
  const observedPrNumber = Number(pr.number);
  const observedHead = typeof pr.headRefOid === 'string' ? pr.headRefOid.trim().toLowerCase() : '';
  if (observedPrNumber !== parsed.prNumber || observedHead !== parsed.headSha) {
    stdout.write(JSON.stringify({
      schema: 'execute-worker-smoke-recoverable-observation/v1',
      ok: false,
      reason: 'worker_smoke_observation_target_drift',
      phase: parsed.phase,
      cause: parsed.cause,
      issueNumber: parsed.issueNumber,
      prNumber: parsed.prNumber,
      expectedHeadSha: parsed.headSha,
      observedHeadSha: observedHead || null,
    }) + '\n');
    return 1;
  }

  const issue = parseGitHubReadJson(runGitHubRead([
    'issue', 'view', String(parsed.issueNumber), '--repo', parsed.repository,
    '--json', 'number,state,body,labels',
  ]), 'worker-smoke Issue observation');
  if (Number(issue.number) !== parsed.issueNumber) {
    throw new Error('worker-smoke Issue observation returned the wrong Issue');
  }

  const issueBody = typeof issue.body === 'string' ? issue.body : '';
  const prBody = typeof pr.body === 'string' ? pr.body : '';
  const revisionMarker = '<!-- source-revision: ' + parsed.sourceRevision + ' -->';
  const closesIssue = new RegExp(
    '^\\s*(closes|fixes|resolves)\\s+#' + parsed.issueNumber + '\\b',
    'im',
  ).test(prBody);
  stdout.write(JSON.stringify({
    schema: 'execute-worker-smoke-recoverable-observation/v1',
    ok: true,
    repository: parsed.repository,
    phase: parsed.phase,
    cause: parsed.cause,
    issueNumber: parsed.issueNumber,
    prNumber: parsed.prNumber,
    headSha: parsed.headSha,
    sourceRevision: parsed.sourceRevision,
    issue: {
      number: parsed.issueNumber,
      state: issue.state,
      body: issueBody,
      labels: issue.labels,
      sourceRevisionPresent: issueBody.includes(revisionMarker),
    },
    pr: {
      number: parsed.prNumber,
      headRefOid: observedHead,
      body: prBody,
      closesIssue,
    },
  }) + '\n');
  return 0;
}

export function runExecuteIssueManagerBoundaryCli(argv: readonly string[], dependencies: CliDependencies = {}): number {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const currentArgv = dependencies.currentArgv ?? process.argv;
  try {
    if (argv.includes('--help') || argv.includes('-h')) { stdout.write(usage() + '\n'); return 0; }
    if (argv[0] === 'observe-worker-smoke-recoverable') {
      return runWorkerSmokeRecoverableObservation(parseWorkerSmokeObservationCli(argv), dependencies);
    }
    const parsed = parseCli(argv);
    const readFile = dependencies.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const input = JSON.parse(readFile(parsed.recordPath)) as unknown;
    const evaluated = classifyExecuteIssueManagerRecord(input, parsed.context);
    stdout.write(JSON.stringify(evaluated.result) + '\n');
    return evaluated.exitCode;
  } catch (error) {
    const evaluated = defectFromCliError(error, currentArgv);
    stdout.write(JSON.stringify(evaluated.result) + '\n');
    stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    return evaluated.exitCode;
  }
}
const direct = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;
if (direct) process.exitCode = runExecuteIssueManagerBoundaryCli(process.argv.slice(2));
