#!/usr/bin/env node
/**
 * T3 stage-completeness guard CLI (Issue #620).
 */
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
} from './lib/stage-completeness-core.js';
import { runDraftTextGuardCli } from './lib/draft-text-guard-cli.js';
import {
  isDirectCliExecution,
  runReviewerTsCli,
} from './lib/reviewer-ts-cli.js';

const GUARD_LABEL = 'stage-completeness guard';

export function runCli(argv: string[]): number {
  return runDraftTextGuardCli(argv, {
    guardLabel: GUARD_LABEL,
    missingInputMessage: '--text-file <path> or --text <string> is required',
    evaluate(text, opts) {
      const result = checkStageCompletenessGuard(text, {
        repoRoot: opts.repoRoot,
        draftPath: opts.draftPath ?? opts.textPath ?? undefined,
      });
      if (!result.ok) {
        return { ok: false, errors: result.errors, passMessage: '' };
      }
      return {
        ok: true,
        passMessage: formatStageCompletenessPassMessage(result),
      };
    },
  });
}

function main(): void {
  process.exit(runCli(process.argv));
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  runReviewerTsCli(main);
}
