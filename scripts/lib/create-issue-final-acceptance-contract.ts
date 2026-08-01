import { readFileSync } from 'node:fs';
import { checkFindingLedgerGuard } from '../finding-ledger-guard.mjs';
import { checkStageCompletenessGuard } from '../lib/stage-completeness-core.ts';
import { checkTierGateGuard } from '../lib/tier-gate-core.ts';
import { validateReceiptMatchesCycle } from './create-issue-stage-record-receipt.ts';
import type { ConsumableStageReceipt } from './create-issue-stage-record-types.ts';

export const FINAL_ACCEPTANCE_CONTRACT_VERSION = 'create-issue-final-acceptance-contract/v1';

export interface FinalAcceptanceGuardInput {
  issueBody: string;
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

  const tierResult = checkTierGateGuard(input.issueBody, {
    tier: input.tier,
    repoRoot: process.cwd(),
  });
  if (!tierResult.ok) errors.push(...tierResult.errors.map((item) => `tier-gate: ${item}`));

  const stageReceipts = input.stageReceiptPaths.map((path) => readJson(path));
  const stageResult = checkStageCompletenessGuard(input.issueBody, {
    phase: 'final-acceptance',
    stageReceipts,
    repoRoot: process.cwd(),
    draftPath: undefined,
  });
  if (!stageResult.ok) errors.push(...stageResult.errors.map((item) => `stage-completeness: ${item}`));

  if (input.ledgerPath) {
    const captures = input.capturePaths.map((path) => readText(path));
    const ledgerText = readText(input.ledgerPath);
    const ledgerResult = checkFindingLedgerGuard(captures.length === 1 ? captures[0]! : captures, ledgerText, {
      phase: 'final-acceptance',
      issueRevision: input.issueRevision,
      stageReceipts,
      verifiedRelayEvidence: (input.relayEvidencePaths ?? []).map((path) => readJson(path)),
      repoRoot: process.cwd(),
    });
    if (!ledgerResult.ok) errors.push(...ledgerResult.errors.map((item) => `finding-ledger: ${item}`));
  }

  for (const receiptValue of stageReceipts) {
    const record = receiptValue as Record<string, unknown>;
    const cycleId = typeof record.cycleId === 'string' ? record.cycleId : '';
    const sourceRevision = typeof record.sourceRevision === 'string' ? record.sourceRevision : '';
    const cycleBinding = record.cycleBinding;
    if (!cycleId || !sourceRevision || !cycleBinding) {
      errors.push('stage receipt missing cycle binding witness');
      continue;
    }
    const consumable: ConsumableStageReceipt = {
      tier: String(record.tier ?? ''),
      stage: String(record.stage ?? ''),
      cycleId,
      stageAttemptId: String(record.stageAttemptId ?? ''),
      policyVersion: String(record.policyVersion ?? ''),
      sourceRevision,
      outcome: record.outcome as ConsumableStageReceipt['outcome'],
      reviewerCardinality: Number(record.reviewerCardinality ?? 0),
      completedSourceCount: Number(record.completedSourceCount ?? record.sourceCount ?? 0),
      cycleBinding: cycleBinding as ConsumableStageReceipt['cycleBinding'],
      producerEvidence: (record.producerEvidence as ConsumableStageReceipt['producerEvidence']) ?? 'not-applicable',
      tierTransition: String(record.tierTransition ?? 'none'),
    };
    errors.push(...validateReceiptMatchesCycle(consumable, input.cycleId, input.issueRevision).map((item) => `cycle-binding: ${item}`));
  }

  if (!input.issueBody.includes(input.issueRevision)) {
    errors.push('issue revision drift detected before final acceptance');
  }

  return {
    ok: errors.length === 0,
    contractVersion: FINAL_ACCEPTANCE_CONTRACT_VERSION,
    errors,
  };
}
