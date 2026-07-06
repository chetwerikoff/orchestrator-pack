#!/usr/bin/env node
/**
 * T3 stage-completeness guard CLI (Issue #620).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
} from './lib/stage-completeness-core.js';
import {
  isDirectCliExecution,
  runReviewerTsCli,
} from './lib/reviewer-ts-cli.js';

interface CliOptions {
  textPath: string | null;
  text: string | null;
  draftPath: string | null;
  repoRoot: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    textPath: null,
    text: null,
    draftPath: null,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--text-file':
        opts.textPath = String(argv[++i] ?? '');
        break;
      case '--draft-path':
        opts.draftPath = String(argv[++i] ?? '');
        break;
      case '--text':
        opts.text = String(argv[++i] ?? '');
        break;
      case '--repo-root':
        opts.repoRoot = resolve(String(argv[++i] ?? opts.repoRoot));
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return opts;
}

export function runCli(argv: string[]): number {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`stage-completeness guard: ${message}\n`);
    return 2;
  }

  if (!opts.textPath && opts.text == null) {
    process.stderr.write(
      'stage-completeness guard: --text-file <path> or --text <string> is required\n',
    );
    return 2;
  }

  const text = opts.textPath ? readFileSync(opts.textPath, 'utf8') : String(opts.text);

  let result;
  try {
    result = checkStageCompletenessGuard(text, {
      repoRoot: opts.repoRoot,
      draftPath: opts.draftPath ?? opts.textPath ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`stage-completeness guard: ${message}\n`);
    return 1;
  }

  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`stage-completeness guard: ${error}\n`);
    }
    return 1;
  }

  process.stdout.write(`${formatStageCompletenessPassMessage(result)}\n`);
  return 0;
}

function main(): void {
  process.exit(runCli(process.argv));
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  runReviewerTsCli(main);
}
