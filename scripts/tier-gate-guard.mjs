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
} from './lib/tier-gate-core.mjs';

function parseArgs(argv) {
  const opts = {
    textPath: null,
    text: null,
    tier: null,
    skipLine: false,
    explicitAdversarialWrapper: false,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    emitStagesJson: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--text-file':
        opts.textPath = argv[++i];
        break;
      case '--text':
        opts.text = argv[++i];
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
        opts.repoRoot = resolve(argv[++i]);
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

export function runCli(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`tier-gate guard: ${error.message}\n`);
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
    });
  } catch (error) {
    process.stderr.write(`tier-gate guard: ${error.message}\n`);
    return 1;
  }

  if (opts.emitStagesJson) {
    const stages = selectAuthoringReviewStages({
      tier: result.receipt?.tier ?? opts.tier,
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

function isCliMain() {
  const entry = process.argv[1]?.replace(/\\/g, '/');
  return Boolean(entry?.endsWith('tier-gate-guard.mjs'));
}

if (isCliMain()) {
  process.exit(runCli(process.argv));
}
