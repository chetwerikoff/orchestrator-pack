import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import { checkSmokeTestPlan, resolveSmokeRequirement } from '../draft-discipline.mjs';
import {
  deriveReviewEpisodeState,
  type ReviewEpisodeDerivationAuthorityV1,
} from '../lib/stage-completeness-core.ts';
import {
  checkTierGateGuard,
  type TierTransitionEvidence,
} from '../lib/tier-gate-core.ts';
import { validateLifecycleAcceptanceTopology } from './create-issue-stage-lifecycle-acceptance.ts';
import type { CanonicalLineage } from './create-issue-stage-record-types.ts';

export const FINAL_ACCEPTANCE_CONTRACT_VERSION = 'create-issue-final-acceptance-contract/v1';
const SOURCE_REVISION_MARKER_RE = /<!--\s*source-revision:\s*(r[0-9]+)\s*-->/i;

export interface PublishedAuthorState {
  text: string;
  sha256: string;
  byteLength: number;
}

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
  stageReceiptValues?: readonly unknown[];
  capturePaths: string[];
  ledgerPath?: string;
  relayEvidencePaths?: string[];
  claudeProducerEvidencePaths?: string[];
  tierReceiptPath?: string;
  tierTransitionEvidence?: TierTransitionEvidence;
  episodeAuthority?: ReviewEpisodeDerivationAuthorityV1;
  canonicalLineage?: CanonicalLineage;
  tierIntakePath?: string;
  externalPassReceiptPath?: string;
  publishedAuthorState?: PublishedAuthorState;
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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

/**
 * The terminal GPT is Issue-lifetime one-shot. Exact body equality is the
 * ordinary path. A later live revision is also legal only as the bounded
 * post-terminal author correction: the one terminal receipt remains bound to
 * the reviewed source marker and no terminal receipt exists for the repaired
 * revision. Finding/disposition guards below still have to accept the repaired
 * state; this function never turns a second terminal verdict into authority.
 */
export function validateTerminalOneShotBodyBinding(
  sourceBody: string,
  currentBody: string | undefined,
  issueRevision: string,
  stageReceipts: readonly unknown[],
  errors: string[],
): boolean {
  if (currentBody === undefined) {
    errors.push('terminal current Issue body is required for exact binding');
    return false;
  }
  const sourceBytes = Buffer.from(sourceBody, 'utf8');
  const currentBytes = Buffer.from(currentBody, 'utf8');
  const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
  const currentSha = createHash('sha256').update(currentBytes).digest('hex');
  if (sourceBytes.byteLength === currentBytes.byteLength && sourceSha === currentSha) return false;

  const sourceRevision = SOURCE_REVISION_MARKER_RE.exec(sourceBody)?.[1];
  const currentRevision = SOURCE_REVISION_MARKER_RE.exec(currentBody)?.[1];
  if (!sourceRevision || !currentRevision || sourceRevision === currentRevision) {
    validateExactTerminalBodyBinding(sourceBody, currentBody, errors);
    return false;
  }
  if (currentRevision !== issueRevision) {
    errors.push(`terminal source body changed outside a bound post-terminal correction: reviewed=${sourceRevision} current=${currentRevision} acceptance=${issueRevision}`);
    return false;
  }
  const sourceOrdinal = Number(sourceRevision.slice(1));
  const currentOrdinal = Number(currentRevision.slice(1));
  if (!Number.isSafeInteger(sourceOrdinal)
    || !Number.isSafeInteger(currentOrdinal)
    || currentOrdinal !== sourceOrdinal + 1) {
    errors.push(`post-terminal correction must advance exactly one source revision: reviewed=${sourceRevision} current=${currentRevision}`);
    return false;
  }
  const correctionErrorCount = errors.length;
  const terminal = stageReceipts.filter((value) => (
    record(value) && value.stage === 'architectural' && value.outcome === 'complete'
  ));
  if (terminal.length !== 1) {
    errors.push(`post-terminal correction requires exactly one original terminal receipt; observed ${terminal.length}`);
    return false;
  }
  const terminalReceipt = terminal[0]! as Record<string, unknown>;
  if (terminalReceipt.sourceRevision !== sourceRevision) {
    errors.push(`post-terminal correction source marker ${sourceRevision} does not match original terminal receipt revision ${String(terminalReceipt.sourceRevision)}`);
  }
  if (stageReceipts.some((value) => record(value) && value.stage === 'architectural' && value.sourceRevision === currentRevision)) {
    errors.push('post-terminal correction must not re-arm or publish a second terminal stage receipt');
  }
  return errors.length === correctionErrorCount;
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

  if (!input.issueRevision.trim()) errors.push('issueRevision is required');
  const currentIssueBody = input.currentIssueBody ?? input.issueBody;
  const smokeRequirement = resolveSmokeRequirement(currentIssueBody);
  if (smokeRequirement.requirement !== 'legacy-exempt') {
    const smokePlanResult = checkSmokeTestPlan(currentIssueBody);
    if (!smokePlanResult.ok) {
      errors.push(...smokePlanResult.errors.map((item) => `smoke-test-plan: ${item}`));
    }
  }

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

  const stageReceipts = input.stageReceiptValues
    ? [...input.stageReceiptValues]
    : input.stageReceiptPaths.flatMap((path) => {
      const value = readJsonSafely(path, readJson, errors, 'stage-completeness');
      return value === null ? [] : [value];
    });
  let episodeAuthority = input.episodeAuthority
    ? { ...input.episodeAuthority, validationPurpose: 'final-acceptance' as const }
    : undefined;
  let intakeValue: unknown = episodeAuthority?.tierIntake;
  if (!episodeAuthority) {
    const intakePath = input.tierIntakePath ?? join(input.reviewDir, 'tier-intake.json');
    const intake = input.tierIntakePath
      ? readJsonSafely(intakePath, readJson, errors, 'stage-completeness')
      : tryReadJson(intakePath, readJson);
    intakeValue = intake;
    const first = stageReceipts[0];
    if (intake && first && typeof intake === 'object' && typeof first === 'object') {
      const intakeRecord = intake as Record<string, unknown>;
      if (typeof intakeRecord.taskIdentity === 'string' && typeof intakeRecord.firstRevision === 'string') {
        const orderedStageReceipts = stageReceipts
          .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
          .sort((left, right) => Number(left.stageSequence ?? 0) - Number(right.stageSequence ?? 0));
        const claudeProducerEvidence = input.claudeProducerEvidencePaths?.flatMap((path) => {
          const value = tryReadJson(path, readJson);
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
          validationPurpose: 'final-acceptance',
        };
      }
    }
  }
  const verifiedRelayEvidence = input.relayEvidencePaths?.flatMap((path) => {
    const value = readJsonSafely(path, readJson, errors, 'stage-completeness');
    return value === null ? [] : Array.isArray(value) ? value : [value];
  }) ?? [];

  const ledgerEpisodeState = deriveReviewEpisodeState(stageReceipts, verifiedRelayEvidence, episodeAuthority);
  if (ledgerEpisodeState.errors.length > 0) {
    errors.push(...ledgerEpisodeState.errors.map((item) => `stage-completeness: ${item}`));
  }
  if (!ledgerEpisodeState.relayComplete) errors.push('stage-completeness: review episode relay is incomplete');
  const lifecycleTopology = validateLifecycleAcceptanceTopology(
    stageReceipts,
    intakeValue,
    input.tier ?? ledgerEpisodeState.tier ?? undefined,
    'final-acceptance',
  );
  if (!lifecycleTopology.ok) errors.push(...lifecycleTopology.errors.map((item) => `stage-completeness: ${item}`));

  const terminalCorrectionCertified = validateTerminalOneShotBodyBinding(
    input.terminalSourceBody ?? input.issueBody,
    input.currentIssueBody,
    input.issueRevision,
    stageReceipts,
    errors,
  );

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
    const ledgerOptions = {
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
      terminalCorrectionCertified,
      ...(input.publishedAuthorState ? { publishedAuthorState: input.publishedAuthorState } : {}),
    } as Parameters<typeof checkFindingLedgerGuard>[2] & { terminalCorrectionCertified: boolean };
    const ledgerResult = checkFindingLedgerGuard(
      captures.length === 1 ? captures[0]! : captures,
      ledgerText,
      ledgerOptions,
    );
    if (!ledgerResult.ok) errors.push(...ledgerResult.errors.map((item) => `finding-ledger: ${item}`));
  }

  if (!currentIssueBody.includes(input.issueRevision)) {
    errors.push('issue revision drift detected before final acceptance');
  }

  return {
    ok: errors.length === 0,
    contractVersion: FINAL_ACCEPTANCE_CONTRACT_VERSION,
    errors: [...new Set(errors)],
  };
}
