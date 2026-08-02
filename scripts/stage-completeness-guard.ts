#!/usr/bin/env node
/** Stage-completeness guard CLI (Issues #620, #1150). */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  checkStageCompletenessGuard,
  formatStageCompletenessPassMessage,
  STAGE_COMPLETENESS_RECEIPT_SCHEMA,
  findLegacyReceiptPaths,
  resolveCanonicalReviewDirectory,
  type ReviewEpisodeDerivationAuthorityV1,
  type StageCompletenessReceiptV1,
  type TierIntakeAuthorityV1,
} from './lib/stage-completeness-core.ts';
import {
  type DraftTextGuardBaseOptions,
  runDraftTextGuardCli,
} from './lib/draft-text-guard-cli.ts';
import { isDirectCliExecution, runReviewerTsCli } from './lib/reviewer-ts-cli.ts';

const GUARD_LABEL = 'stage-completeness guard';

export type CanonicalReceiptInventoryOptions = {
  stageReceiptPaths?: string[];
  receiptDirectory?: string;
  tierIntakePath?: string;
  claudeProducerEvidencePaths?: string[];
};

type ReceiptCliOptions = DraftTextGuardBaseOptions & CanonicalReceiptInventoryOptions & {
  relayEvidencePath?: string;
  phase?: 'pre-lens' | 'final-acceptance';
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function asObjects(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isStageReceipt(value: unknown): value is StageCompletenessReceiptV1 {
  return Boolean(value) && typeof value === 'object'
    && (value as { schema?: unknown }).schema === STAGE_COMPLETENESS_RECEIPT_SCHEMA;
}

export function loadCanonicalReceiptInventory(opts: CanonicalReceiptInventoryOptions): {
  receipts: StageCompletenessReceiptV1[];
  receiptValues: StageCompletenessReceiptV1[];
  receiptPaths: string[];
  intakePath: string;
  authority: ReviewEpisodeDerivationAuthorityV1;
} {
  if (!opts.tierIntakePath) throw new Error('--tier-intake is required for receipt-backed review episodes');
  const intake = readJson(opts.tierIntakePath) as TierIntakeAuthorityV1;
  const canonical = resolveCanonicalReviewDirectory(intake);
  const legacyReceiptPath = findLegacyReceiptPaths(intake)[0];
  if (legacyReceiptPath) {
    throw new Error(`legacy_receipt_location_blocked: receipt found outside canonical authority at ${legacyReceiptPath}`);
  }
  if (resolve(opts.tierIntakePath) !== canonical.intakePath) {
    throw new Error(`legacy_receipt_location_blocked: tier intake authority must be ${canonical.intakePath}`);
  }
  const requestedDirectory = opts.receiptDirectory
    ? resolve(opts.receiptDirectory)
    : opts.stageReceiptPaths?.[0]
      ? dirname(resolve(opts.stageReceiptPaths[0]))
      : canonical.directory;
  if (requestedDirectory !== canonical.directory) {
    throw new Error(`legacy_receipt_location_blocked: receipt authority must be ${canonical.directory}`);
  }
  const directory = canonical.directory;
  if (!existsSync(directory)) throw new Error(`receipt directory does not exist: ${directory}`);
  const explicit = new Set((opts.stageReceiptPaths ?? []).map((path) => resolve(path)));
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => resolve(directory, name));
  const receipts: StageCompletenessReceiptV1[] = [];
  const receiptPaths: string[] = [];
  for (const path of candidates) {
    let parsed: unknown;
    try {
      parsed = readJson(path);
    } catch (error) {
      if (explicit.has(path) || /stage-completeness-receipt/i.test(path)) throw error;
      continue;
    }
    const found = asObjects(parsed).filter(isStageReceipt);
    if (found.length === 0) {
      if (explicit.has(path)) throw new Error(`explicit --stage-receipt is not ${STAGE_COMPLETENESS_RECEIPT_SCHEMA}: ${path}`);
      continue;
    }
    receipts.push(...found);
    receiptPaths.push(path);
  }
  for (const path of explicit) {
    if (!candidates.includes(path)) throw new Error(`explicit stage receipt is outside canonical receipt directory: ${path}`);
  }
  receipts.sort((left, right) => left.stageSequence - right.stageSequence || left.stageReceiptId.localeCompare(right.stageReceiptId));
  if (receipts.length === 0) throw new Error(`no ${STAGE_COMPLETENESS_RECEIPT_SCHEMA} files found in ${directory}`);
  const evidence = (opts.claudeProducerEvidencePaths ?? []).flatMap((path) => asObjects(readJson(path)));
  return {
    receipts,
    receiptValues: receipts,
    receiptPaths,
    intakePath: canonical.intakePath,
    authority: {
      tierIntake: intake,
      receiptInventory: {
        source: 'canonical-review-directory',
        taskIdentity: intake.taskIdentity,
        episodeFirstRevision: intake.firstRevision,
        reviewEpisodeId: `${intake.taskIdentity}@${intake.firstRevision}`,
        stageReceiptIds: receipts.map((receipt) => receipt.stageReceiptId),
      },
      claudeProducerEvidence: evidence,
    },
  };
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
      const receiptBacked = Boolean(opts.receiptDirectory || opts.stageReceiptPaths?.length);
      const loaded = receiptBacked ? loadCanonicalReceiptInventory(opts) : null;
      const result = checkStageCompletenessGuard(text, {
        repoRoot: opts.repoRoot,
        draftPath: opts.draftPath ?? opts.textPath ?? undefined,
        stageReceipts: loaded?.receipts,
        verifiedRelayEvidence: loaded ? loadRelayEvidence(opts.relayEvidencePath) : undefined,
        episodeAuthority: loaded?.authority,
        phase: opts.phase,
      });
      if (!result.ok) return { ok: false, errors: result.errors, passMessage: '' };
      return { ok: true, passMessage: formatStageCompletenessPassMessage(result) };
    },
  }, (arg, values, index, baseOpts) => {
    const opts = baseOpts as ReceiptCliOptions;
    const value = String(values[index + 1] ?? '');
    if (arg === '--stage-receipt') {
      if (!value) throw new Error('--stage-receipt requires a path');
      opts.stageReceiptPaths ??= [];
      opts.stageReceiptPaths.push(value);
      return index + 1;
    }
    if (arg === '--receipt-directory') {
      if (!value) throw new Error('--receipt-directory requires a path');
      opts.receiptDirectory = value;
      return index + 1;
    }
    if (arg === '--tier-intake') {
      if (!value) throw new Error('--tier-intake requires a path');
      opts.tierIntakePath = value;
      return index + 1;
    }
    if (arg === '--claude-producer-evidence') {
      if (!value) throw new Error('--claude-producer-evidence requires a path');
      opts.claudeProducerEvidencePaths ??= [];
      opts.claudeProducerEvidencePaths.push(value);
      return index + 1;
    }
    if (arg === '--verified-relay-evidence') {
      if (!value) throw new Error('--verified-relay-evidence requires a path');
      opts.relayEvidencePath = value;
      return index + 1;
    }
    if (arg === '--phase') {
      if (value !== 'pre-lens' && value !== 'final-acceptance') throw new Error('--phase must be pre-lens or final-acceptance');
      opts.phase = value;
      return index + 1;
    }
    return 'unknown';
  });
}

function main(): void {
  process.exit(runCli(process.argv));
}

if (isDirectCliExecution(import.meta.url, process.argv[1])) runReviewerTsCli(main);
