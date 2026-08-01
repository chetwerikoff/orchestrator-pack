#!/usr/bin/env node
/**
 * Stage-completeness guard CLI (Issues #620, #1150).
 */
import { readFileSync } from 'node:fs';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
} from './lib/stage-completeness-core.ts';
import {
  type DraftTextGuardBaseOptions,
  runDraftTextGuardCli,
} from './lib/draft-text-guard-cli.ts';
import {
  isDirectCliExecution,
  runReviewerTsCli,
} from './lib/reviewer-ts-cli.ts';

const GUARD_LABEL = 'stage-completeness guard';

type ReceiptCliOptions = DraftTextGuardBaseOptions & {
  stageReceiptPaths?: string[];
  relayEvidencePath?: string;
  phase?: 'pre-lens' | 'final-acceptance';
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadStageReceipts(paths: readonly string[]): unknown[] {
  return paths.flatMap((path) => {
    const value = readJson(path);
    return Array.isArray(value) ? value : [value];
  });
}

function loadRelayEvidence(path?: string): unknown[] {
  if (!path) return [];
  const value = readJson(path);
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as { evidence?: unknown[] }).evidence)) {
    return (value as { evidence: unknown[] }).evidence;
  }
  throw new Error('--verified-relay-evidence must contain a JSON array or {"evidence": [...]}');
}

export function runCli(argv: string[]): number {
  return runDraftTextGuardCli(argv, {
    guardLabel: GUARD_LABEL,
    missingInputMessage: '--text-file <path> or --text <string> is required',
    evaluate(text, baseOpts) {
      const opts = baseOpts as ReceiptCliOptions;
      const receiptPaths = opts.stageReceiptPaths ?? [];
      const result = checkStageCompletenessGuard(text, {
        repoRoot: opts.repoRoot,
        draftPath: opts.draftPath ?? opts.textPath ?? undefined,
        stageReceipts: receiptPaths.length > 0 ? loadStageReceipts(receiptPaths) : undefined,
        verifiedRelayEvidence: receiptPaths.length > 0
          ? loadRelayEvidence(opts.relayEvidencePath)
          : undefined,
        phase: opts.phase,
      });
      if (!result.ok) return { ok: false, errors: result.errors, passMessage: '' };
      return { ok: true, passMessage: formatStageCompletenessPassMessage(result) };
    },
  }, (arg, values, index, baseOpts) => {
    const opts = baseOpts as ReceiptCliOptions;
    if (arg === '--stage-receipt') {
      const path = String(values[index + 1] ?? '');
      if (!path) throw new Error('--stage-receipt requires a path');
      opts.stageReceiptPaths ??= [];
      opts.stageReceiptPaths.push(path);
      return index + 1;
    }
    if (arg === '--verified-relay-evidence') {
      const path = String(values[index + 1] ?? '');
      if (!path) throw new Error('--verified-relay-evidence requires a path');
      opts.relayEvidencePath = path;
      return index + 1;
    }
    if (arg === '--phase') {
      const phase = String(values[index + 1] ?? '');
      if (phase !== 'pre-lens' && phase !== 'final-acceptance') {
        throw new Error('--phase must be pre-lens or final-acceptance');
      }
      opts.phase = phase;
      return index + 1;
    }
    return 'unknown';
  });
}

function main(): void {
  process.exit(runCli(process.argv));
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) {
  runReviewerTsCli(main);
}
