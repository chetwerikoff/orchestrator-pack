import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import {
  checkStageCompletenessGuard,
  deriveReviewEpisodeState,
  type ReviewEpisodeDerivationAuthorityV1,
} from '../lib/stage-completeness-core.ts';
import {
  checkTierGateGuard,
  type TierTransitionEvidence,
} from '../lib/tier-gate-core.ts';
import { parseConsumableStageReceipt, validateReceiptMatchesCycle } from './create-issue-stage-record-receipt.ts';

export const FINAL_ACCEPTANCE_CONTRACT_VERSION = 'create-issue-final-acceptance-contract/v1';

export interface FinalAcceptanceGuardInput {
  issueBody: string;
  /** Immutable body artifact supplied to the terminal reviewer. */
  terminalSourceBody?: string;
  /** Fresh GitHub Issue body read for this acceptance attempt. */
  currentIssueBody?: string;
  issueRevision: string;
  cycleId: string;
  tier?: string;
  reviewDir: string;
  stageReceiptPaths: string[];
  capturePaths: string[];
  ledgerPath?: string;
  relayEvidencePaths?: string[];
  claudeProducerEvidencePaths?: string[];
  tierReceiptPath?: string;
  tierTransitionEvidence?: TierTransitionEvidence;
  episodeAuthority?: ReviewEpisodeDerivationAuthorityV1;
  tierIntakePath?: string;
  externalPassReceiptPath?: string;
  readText?: (path: string) => string;
  readJson?: (path: string) => unknown;
}

export interface FinalAcceptanceGuardResult {
  ok: boolean;
  contractVersion: string;
  errors: string[];
}

function defaultReadText(path: string): string {
  return readFileSync(path, 'utf8');
}

function defaultReadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonSafely(
  path: string,
  readJson: (path: string) => unknown,
  errors: string[],
  label: string,
): unknown | null {
  try {
    return readJson(path);
  } catch {
    errors.push(`${label}: unable to read ${path}`);
    return null;
  }
}

function readTextSafely(
  path: string,
  readText: (path: string) => string,
  errors: string[],
  label: string,
): string | null {
  try {
    return readText(path);
  } catch {
    errors.push(`${label}: unable to read ${path}`);
    return null;
  }
}

function tryReadJson(path: string, readJson: (path: string) => unknown): unknown | null {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

export function validateExactTerminalBodyBinding(
  sourceBody: string,
  currentBody: string | undefined,
  errors: string[],
): void {
  if (currentBody === undefined) {
    errors.push('terminal current Issue body is required for exact binding');
    return;
  }
  const sourceBytes = Buffer.from(sourceBody, 'utf8');
  const currentBytes = Buffer.from(currentBody, 'utf8');
  if (sourceBytes.byteLength !== currentBytes.byteLength) {
    errors.push(`terminal source body byteLength mismatch: reviewed=${sourceBytes.byteLength} current=${currentBytes.byteLength}`);
    return;
  }
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const currentSha256 = createHash('sha256').update(currentBytes).digest('hex');
  if (sourceSha256 !== currentSha256) {
    errors.push(`terminal source body sha256 mismatch: reviewed=${sourceSha256} current=${currentSha256}`);
  }
}

export function executeFinalAcceptanceGuards(
  input: FinalAcceptanceGuardInput,
): FinalAcceptanceGuardResult {
  const errors: string[] = [];
  const readText = input.readText ?? defaultReadText;
  const readJson = input.readJson ?? defaultReadJson;

  if (input.externalPassReceiptPath) {
    errors.push('external PASS receipt consumption is forbidden; execute shared guards directly');
    return {
      ok: false,
      contractVersion: FINAL_ACCEPTANCE_CONTRACT_VERSION,
      errors,
    };
  }

  if (!input.cycleId.trim()) errors.push('cycleId is required');
  if (!input.issueRevision.trim()) errors.push('issueRevision is required');
  validateExactTerminalBodyBinding(input.terminalSourceBody ?? input.issueBody, input.currentIssueBody, errors);

  const tierEvidence = input.tierTransitionEvidence
    ?? (input.tierReceiptPath
      ? readJsonSafely(input.tierReceiptPath, readJson, errors, 'tier-gate')
      : null);
  const transitionEvidence = tierEvidence && typeof tierEvidence === 'object'
    && 'revisions' in tierEvidence && 'intake' in tierEvidence
    ? tierEvidence as TierTransitionEvidence
    : input.tierTransitionEvidence;

  const tierResult = checkTierGateGuard(input.issueBody, {
    tier: input.tier,
    repoRoot: process.cwd(),
    transitionEvidence,
  });
  if (!tierResult.ok) errors.push(...tierResult.errors.map((item) => `tier-gate: ${item}`));

  const stageReceipts = input.stageReceiptPaths.flatMap((path) => {
    const value = readJsonSafely(path, readJson, errors, 'stage-completeness');
    return value === null ? [] : [value];
  });
  const consumableReceipts = stageReceipts.map((value, index) => {
    const parsed = parseConsumableStageReceipt(value);
    if (!parsed.receipt) {
      errors.push(...parsed.errors.map((error) => `cycle-binding receipt ${index + 1}: ${error}`));
    }
    return parsed.receipt;
  }).filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null);

  let episodeAuthority = input.episodeAuthority;
  if (!episodeAuthority) {
    const intakePath = input.tierIntakePath ?? join(input.reviewDir, 'tier-intake.json');
    const intake = input.tierIntakePath
      ? readJsonSafely(intakePath, readJson, errors, 'stage-completeness')
      : tryReadJson(intakePath, readJson);
    const first = stageReceipts[0];
    if (intake && first && typeof intake === 'object' && typeof first === 'object') {
      const intakeRecord = intake as Record<string, unknown>;
      if (typeof intakeRecord.taskIdentity === 'string' && typeof intakeRecord.firstRevision === 'string') {
        const orderedStageReceipts = stageReceipts
          .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
          .sort((left, right) => Number(left.stageSequence ?? 0) - Number(right.stageSequence ?? 0));
        const claudeProducerEvidence = input.claudeProducerEvidencePaths?.flatMap((path) => {
          const value = readJsonSafely(path, readJson, errors, 'stage-completeness');
          return value === null ? [] : [value];
        });
        episodeAuthority = {
          tierIntake: intake as ReviewEpisodeDerivationAuthorityV1['tierIntake'],
          receiptInventory: {
            source: 'canonical-review-directory',
            taskIdentity: intakeRecord.taskIdentity,
            episodeFirstRevision: intakeRecord.firstRevision,
            reviewEpisodeId: `${intakeRecord.taskIdentity}@${intakeRecord.firstRevision}`,
            stageReceiptIds: orderedStageReceipts.flatMap((value) => {
              const stageReceiptId = value.stageReceiptId;
              return typeof stageReceiptId === 'string' ? [stageReceiptId] : [];
            }),
          },
          claudeProducerEvidence,
        };
      }
    }
  }
  const verifiedRelayEvidence = input.relayEvidencePaths?.flatMap((path) => {
    const value = readJsonSafely(path, readJson, errors, 'stage-completeness');
    return value === null ? [] : Array.isArray(value) ? value : [value];
  }) ?? [];
  const stageResult = checkStageCompletenessGuard(input.issueBody, {
    phase: 'final-acceptance',
    stageReceipts,
    verifiedRelayEvidence,
    episodeAuthority,
    repoRoot: process.cwd(),
    draftPath: undefined,
  });
  if (!stageResult.ok) errors.push(...stageResult.errors.map((item) => `stage-completeness: ${item}`));

  const ledgerEpisodeState = deriveReviewEpisodeState(stageReceipts, verifiedRelayEvidence, episodeAuthority);

  if (!input.ledgerPath) {
    errors.push('finding-ledger: ledger path is required for final acceptance');
  } else {
    const captures = input.capturePaths.flatMap((path) => {
      const value = readTextSafely(path, readText, errors, 'finding-ledger');
      return value === null ? [] : [value];
    });
    const ledgerText = readTextSafely(input.ledgerPath, readText, errors, 'finding-ledger');
    if (ledgerText === null) {
      return { ok: false, contractVersion: FINAL_ACCEPTANCE_CONTRACT_VERSION, errors: [...new Set(errors)] };
    }
    const ledgerResult = checkFindingLedgerGuard(captures.length === 1 ? captures[0]! : captures, ledgerText, {
      phase: 'final-acceptance',
      issueRevision: input.issueRevision,
      stageReceipts: ledgerEpisodeState.receipts,
      verifiedRelayEvidence,
      episodeAuthority,
      captureMetadata: input.capturePaths.map((path, index) => ({
        name: basename(path),
        timestampMs: index + 1,
      })),
      repoRoot: process.cwd(),
    });
    if (!ledgerResult.ok) errors.push(...ledgerResult.errors.map((item) => `finding-ledger: ${item}`));
  }

  for (const receipt of consumableReceipts) errors.push(...validateReceiptMatchesCycle(receipt, input.cycleId, input.issueRevision).map((item) => `cycle-binding: ${item}`));

  if (!input.issueBody.includes(input.issueRevision)) {
    errors.push('issue revision drift detected before final acceptance');
  }

  return {
    ok: errors.length === 0,
    contractVersion: FINAL_ACCEPTANCE_CONTRACT_VERSION,
    errors,
  };
}
