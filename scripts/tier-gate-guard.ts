#!/usr/bin/env node
/**
 * Tier-gate guard CLI (Issue #576).
 */
import { readFileSync } from 'node:fs';
import {
  checkTierGateGuard,
  formatTierGatePassMessage,
  selectAuthoringReviewStages,
} from './lib/tier-gate-core.js';
import {
  createDraftTextGuardBaseOptions,
  parseDraftTextGuardArgv,
  type DraftTextGuardBaseOptions,
} from './lib/draft-text-guard-cli.js';
import {
  isDirectCliExecution,
  runReviewerTsCli,
} from './lib/reviewer-ts-cli.js';

interface CliOptions extends DraftTextGuardBaseOptions {
  tier: string | null;
  skipLine: boolean;
  explicitAdversarialWrapper: boolean;
  emitStagesJson: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    ...createDraftTextGuardBaseOptions(),
    tier: null,
    skipLine: false,
    explicitAdversarialWrapper: false,
    emitStagesJson: false,
  };

  parseDraftTextGuardArgv(argv, opts, (arg, args, index) => {
    switch (arg) {
      case '--tier':
        opts.tier = String(args[++index] ?? '').toUpperCase();
        return index;
      case '--skip-line':
        opts.skipLine = true;
        return 'handled';
      case '--explicit-adversarial-wrapper':
        opts.explicitAdversarialWrapper = true;
        return 'handled';
      case '--emit-stages-json':
        opts.emitStagesJson = true;
        return 'handled';
      default:
        return 'unknown';
    }
  });

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
