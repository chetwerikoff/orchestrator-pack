import { mkdirSync, readFileSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildSourceRecords,
  canonicalJson,
  sha256,
  type ReviewTopology,
  type SourceRecord,
} from './create-issue-stage-topology.ts';

export const COMPLETED_RESULT_SCHEMA = 'create-issue-completed-result/v1' as const;
export const PUBLICATION_EVENT_SCHEMA = 'create-issue-publication-event/v1' as const;

export interface CompletedTurn {
  turnIdentity: string;
  stageAttemptId: string;
  slot: string;
  rawOutput: string;
  terminal: true;
}

export interface CompletedResult extends CompletedTurn {
  schema: typeof COMPLETED_RESULT_SCHEMA;
  outputId: string;
  rawOutputBase64: string;
  committedAt: string;
}

export interface PublicationEvent {
  schema: typeof PUBLICATION_EVENT_SCHEMA;
  eventKey: string;
  recordKind: 'source';
  issueNumber: number;
  cycleId: string;
  sourceRevision: string;
  stage: string;
  stageAttemptId: string;
  policyVersion: string;
  reviewerCardinality: number;
  cardinalityConfigIdentity: string;
  slot: string;
  outputId: string;
  rawOutputBase64: string;
  records: SourceRecord[];
}

export type CompletedRecoveryState =
  | 'turn-completed-awaiting-harvest'
  | 'completed-awaiting-event'
  | 'completed-unpublished'
  | 'publication-pending'
  | 'published'
  | 'terminal-producer-failed';

export interface CompletedRecoveryResult {
  state: CompletedRecoveryState;
  result?: CompletedResult;
  event?: PublicationEvent;
  reason?: string;
  sendCount: 0;
}

function resultRoot(issueNumber: number): string {
  const stateRoot = process.env.OPK_CREATE_ISSUE_DRAFT_STATE_ROOT
    ?? join(homedir(), '.local', 'state', 'create-issue-draft');
  return join(stateRoot, String(issueNumber), 'completed');
}

function resultPath(issueNumber: number, turnIdentity: string): string {
  return join(resultRoot(issueNumber), `${sha256(turnIdentity)}.json`);
}

export function completedResultPath(issueNumber: number, turnIdentity: string): string {
  return resultPath(issueNumber, turnIdentity);
}

export function readCompletedResult(issueNumber: number, turnIdentity: string): CompletedResult | null {
  const path = resultPath(issueNumber, turnIdentity);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CompletedResult;
    if (parsed.schema !== COMPLETED_RESULT_SCHEMA || parsed.turnIdentity !== turnIdentity) return null;
    const bytes = Buffer.from(parsed.rawOutputBase64, 'base64');
    if (sha256(bytes) !== parsed.outputId || bytes.toString('utf8') !== parsed.rawOutput) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function commitCompletedResult(issueNumber: number, turn: CompletedTurn): CompletedResult {
  if (!turn.terminal || !turn.turnIdentity || !turn.stageAttemptId || !turn.slot) {
    throw new Error('completed-result-unavailable');
  }
  const bytes = new TextEncoder().encode(turn.rawOutput);
  if (bytes.length === 0) throw new Error('empty-output');
  const result: CompletedResult = {
    ...turn,
    schema: COMPLETED_RESULT_SCHEMA,
    outputId: sha256(bytes),
    rawOutputBase64: Buffer.from(bytes).toString('base64'),
    committedAt: new Date().toISOString(),
  };
  const path = resultPath(issueNumber, turn.turnIdentity);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result)}\n`, { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, path);
  return result;
}

export function harvestExistingTurn(issueNumber: number, turn: CompletedTurn): CompletedRecoveryResult {
  const existing = readCompletedResult(issueNumber, turn.turnIdentity);
  if (existing) {
    if (existing.rawOutput !== turn.rawOutput || existing.stageAttemptId !== turn.stageAttemptId || existing.slot !== turn.slot) {
      return { state: 'terminal-producer-failed', reason: 'incompatible-identity', sendCount: 0 };
    }
    return { state: 'completed-awaiting-event', result: existing, sendCount: 0 };
  }
  try {
    return { state: 'completed-awaiting-event', result: commitCompletedResult(issueNumber, turn), sendCount: 0 };
  } catch (error) {
    return { state: 'terminal-producer-failed', reason: error instanceof Error ? error.message : String(error), sendCount: 0 };
  }
}

export function constructPublicationEvent(
  topology: ReviewTopology,
  completed: CompletedResult,
): PublicationEvent {
  if (completed.stageAttemptId !== topology.stageAttemptId) throw new Error('incompatible-identity');
  if (!topology.requiredSlots.includes(completed.slot)) throw new Error('invalid-identity');
  const records = buildSourceRecords(topology, completed.slot, completed.rawOutput);
  const eventKey = sha256(canonicalJson({
    schema: PUBLICATION_EVENT_SCHEMA,
    recordKind: 'source',
    issueNumber: topology.issueNumber,
    cycleId: topology.cycleId,
    sourceRevision: topology.sourceRevision,
    stage: topology.stage,
    stageAttemptId: topology.stageAttemptId,
    policyVersion: topology.policyVersion,
    reviewerCardinality: topology.reviewerCardinality,
    cardinalityConfigIdentity: topology.cardinalityConfigIdentity,
    slot: completed.slot,
    outputId: completed.outputId,
  }));
  return {
    schema: PUBLICATION_EVENT_SCHEMA,
    eventKey,
    recordKind: 'source',
    issueNumber: topology.issueNumber,
    cycleId: topology.cycleId,
    sourceRevision: topology.sourceRevision,
    stage: topology.stage,
    stageAttemptId: topology.stageAttemptId,
    policyVersion: topology.policyVersion,
    reviewerCardinality: topology.reviewerCardinality,
    cardinalityConfigIdentity: topology.cardinalityConfigIdentity,
    slot: completed.slot,
    outputId: completed.outputId,
    rawOutputBase64: completed.rawOutputBase64,
    records,
  };
}

export function recoverCompletedTurn(
  issueNumber: number,
  turn: CompletedTurn | null,
  topology: ReviewTopology,
): CompletedRecoveryResult {
  if (!turn || !turn.terminal) return { state: 'turn-completed-awaiting-harvest', reason: 'completed-turn-unavailable', sendCount: 0 };
  const harvested = harvestExistingTurn(issueNumber, turn);
  if (!harvested.result || harvested.state === 'terminal-producer-failed') return harvested;
  try {
    return { ...harvested, state: 'completed-unpublished', event: constructPublicationEvent(topology, harvested.result) };
  } catch (error) {
    return { state: 'terminal-producer-failed', reason: error instanceof Error ? error.message : String(error), result: harvested.result, sendCount: 0 };
  }
}
