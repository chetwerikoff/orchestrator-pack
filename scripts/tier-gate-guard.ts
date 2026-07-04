#!/usr/bin/env node
/**
 * Tier-gate guard CLI (Issue #576).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTierGateGuard,
  formatTierGatePassMessage,
  selectAuthoringReviewStages,
} from './lib/tier-gate-core.js';
import {
  isDirectCliExecution,
  runReviewerTsCli,
} from './lib/reviewer-ts-cli.js';

interface CliOptions {
  textPath: string | null;
  text: string | null;
  draftPath: string | null;
  tier: string | null;
  skipLine: boolean;
  explicitAdversarialWrapper: boolean;
  repoRoot: string;
  emitStagesJson: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    textPath: null,
    text: null,
    draftPath: null,
    tier: null,
    skipLine: false,
    explicitAdversarialWrapper: false,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    emitStagesJson: false,
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
      case '--tier':
        opts.tier = String(argv[++i] ?? '').toUpperCase();
        break;
      case '--skip-line':
        opts.skipLine = true;
        break;
      case '--explicit-adversarial-wrapper':
        opts.explicitAdversarialWrapper = true;
        break;
      case '--repo-root':
        opts.repoRoot = resolve(String(argv[++i] ?? opts.repoRoot));
        break;
      case '--emit-stages-json':
        opts.emitStagesJson = true;
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
    process.stderr.write(`tier-gate guard: ${message}\n`);
    return 2;
  }

  if (!opts.textPath && opts.text == null) {
    process.stderr.write('tier-gate guard: --text-file <path> or --text <string> is required\n');
    return 2;
  }

  const text = opts.textPath ? readFileSync(opts.textPath, 'utf8') : String(opts.text);

  let result;
  try {
    result = checkTierGateGuard(text, {
      tier: opts.tier,
      skipLine: opts.skipLine,
      explicitAdversarialWrapper: opts.explicitAdversarialWrapper,
      repoRoot: opts.repoRoot,
      draftPath: opts.draftPath ?? opts.textPath ?? undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tier-gate guard: ${message}\n`);
    return 1;
  }

  if (opts.emitStagesJson) {
    const stages = selectAuthoringReviewStages({
      tier: result.receipt?.kind === 'tier-fence' ? result.receipt.tier : opts.tier,
      skipLine: opts.skipLine || result.fence.kind === 'no-tier',
      explicitAdversarialWrapper: opts.explicitAdversarialWrapper,
    });
    process.stdout.write(`${JSON.stringify(stages)}\n`);
  }

  if (!result.ok) {
    for (const error of result.errors) {
      process.stderr.write(`tier-gate guard: ${error}\n`);
    }
    return 1;
  }

  process.stdout.write(`${formatTierGatePassMessage(result)}\n`);
  return 0;
}

function main(): void {
  process.exit(runCli(process.argv));
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  runReviewerTsCli(main);
}
