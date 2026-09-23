#!/usr/bin/env -S node --experimental-strip-types

import './toolchain/native-entrypoint-preflight.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
}
interface ParsedCli { recordPath: string; context: ExecuteIssueManagerBoundaryContext; }

function usage(): string {
  return [
    'Execute-Issue manager result boundary', '', 'Usage:',
    '  node --experimental-strip-types scripts/execute-issue-manager-boundary.ts classify',
    '    --record <path> --repo <owner/repo> --issue-number <n> --source-revision <rNN>',
    '    --phase <implementation|review|fixer> [--cdp <url>]',
    '    [--target-id <id> | --conversation-url <url>] [--pr-number <n>]', '',
    'This classifier emits only the shared four-outcome manager result contract.',
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
  const allowed = new Set(['--record', '--repo', '--issue-number', '--source-revision', '--phase', '--cdp', '--target-id', '--conversation-url', '--pr-number']);
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
  const prRaw = values.get('--pr-number');
  return {
    recordPath,
    context: {
      repository,
      issueNumber: positiveInteger(values.get('--issue-number'), '--issue-number'),
      sourceRevision,
      phase: parsePhase(values.get('--phase')),
      ...(values.get('--cdp') ? { cdp: values.get('--cdp') } : {}),
      ...(targetId ? { targetId } : {}),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(prRaw ? { prNumber: positiveInteger(prRaw, '--pr-number') } : {}),
    },
  };
}
function defectFromCliError(error: unknown, currentArgv: readonly string[]) {
  return evaluateCreateIssueManagerBoundary({
    producer: 'execute-issue-manager-boundary.ts:cli', currentArgv,
    produce: () => { throw error instanceof Error ? error : new Error(String(error)); },
  });
}
export function runExecuteIssueManagerBoundaryCli(argv: readonly string[], dependencies: CliDependencies = {}): number {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const currentArgv = dependencies.currentArgv ?? process.argv;
  try {
    if (argv.includes('--help') || argv.includes('-h')) { stdout.write(usage() + '\n'); return 0; }
    const parsed = parseCli(argv);
    const readFile = dependencies.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
    const input = JSON.parse(readFile(parsed.recordPath)) as unknown;
    const evaluated = classifyExecuteIssueManagerRecord(input, { ...parsed.context, currentArgv });
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
