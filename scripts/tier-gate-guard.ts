#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkTierGateGuard, formatTierGatePassMessage } from './lib/tier-gate-core.ts';
import { isDirectCliExecution, runReviewerTsCli } from './lib/reviewer-ts-cli.ts';

function parseArgs(argv: string[]): { text: string | null; textFile: string | null; repoRoot?: string } {
  let text: string | null = null;
  let textFile: string | null = null;
  let repoRoot: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--text') text = String(argv[++index] ?? '');
    else if (arg === '--text-file') textFile = String(argv[++index] ?? '');
    else if (arg === '--repo-root') repoRoot = String(argv[++index] ?? '');
    else throw new Error('unknown argument: ' + arg);
  }
  if ((text === null) === (textFile === null)) {
    throw new Error('exactly one of --text or --text-file is required');
  }
  return { text, textFile, ...(repoRoot ? { repoRoot } : {}) };
}

export function runCli(argv: string[]): number {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write('tier-gate guard: ' + (error instanceof Error ? error.message : String(error)) + '\n');
    return 2;
  }
  const text = options.textFile ? readFileSync(options.textFile, 'utf8') : String(options.text);
  const result = checkTierGateGuard(text, {
    ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
    ...(options.textFile ? { draftPath: options.textFile } : {}),
  });
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write('tier-gate guard: ' + error + '\n');
    return 1;
  }
  process.stdout.write(formatTierGatePassMessage(result) + '\n');
  return 0;
}

function main(): void {
  process.exit(runCli(process.argv));
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) runReviewerTsCli(main);
