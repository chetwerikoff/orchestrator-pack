import { join } from 'node:path';
import {
  acquireReviewStartClaim,
  claimKey,
  claimLockDir,
  claimPath,
  readClaimRecord,
  resolveReviewStartClaimNamespace,
  updateReviewStartClaimRecordFields,
  type ClaimResult,
  type ReviewStartClaimRecord,
  type UnknownRecord,
} from './review-start-claim-store.ts';

export const PACK_REVIEW_STAGE = 'pack-review' as const;
export const PACK_REVIEW_STAGE_SUBDIR = 'stage-pack-review';

export type PackReviewTurnState =
  | 'none'
  | 'live'
  | 'possible_delivery'
  | 'completed'
  | 'proven_non_delivery';

export type EstablishedPriorTurnState = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'unknown';

export interface PackReviewStageClaimFields {
  stage: typeof PACK_REVIEW_STAGE;
  turnState: PackReviewTurnState;
  invocationId?: string;
  chatUrl?: string;
  replyPath?: string;
  workDir?: string;
  childPid?: number;
  remediationCompleted?: boolean;
  provenNonDelivery?: {
    scope: string;
    cause: string;
    phase?: string;
    remediatedAtUtc?: string;
  };
}

export interface PackReviewStageClaimRecord extends ReviewStartClaimRecord, PackReviewStageClaimFields {}

function asString(value: unknown): string {
  return String(value ?? '').trim();
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

export function resolvePackReviewStageClaimNamespace(input: { projectId?: string; namespace?: string } = {}): string {
  const explicit = asString(input.namespace);
  if (explicit) return explicit;
  const base = resolveReviewStartClaimNamespace(input);
  return join(base, PACK_REVIEW_STAGE_SUBDIR);
}

export function packReviewStageClaimPath(namespace: string, prNumber: number, headSha: string): string {
  return claimPath(namespace, prNumber, headSha);
}

export function packReviewStageClaimLockDir(namespace: string, prNumber: number, headSha: string): string {
  return claimLockDir(namespace, prNumber, headSha);
}

export function packReviewStageClaimKey(prNumber: number, headSha: string): string {
  return claimKey(prNumber, headSha);
}

export function readPackReviewStageClaim(
  namespace: string,
  prNumber: number,
  headSha: string,
): { ok: true; record: PackReviewStageClaimRecord; path: string } | { ok: false; reason: string; path: string } {
  const path = packReviewStageClaimPath(namespace, prNumber, headSha);
  const read = readClaimRecord(path);
  if (!read.ok || !read.record) {
    return { ok: false, reason: read.reason ?? 'missing', path };
  }
  const record = read.record as PackReviewStageClaimRecord;
  if (asString(record.stage) !== PACK_REVIEW_STAGE) {
    return { ok: false, reason: 'incompatible_stage_claim', path };
  }
  return { ok: true, record, path };
}

export function acquirePackReviewStageClaim(input: {
  prNumber: number;
  headSha: string;
  surface: string;
  projectId?: string;
  namespace?: string;
  startReason?: string;
  holderContext?: UnknownRecord;
}): ClaimResult {
  const namespace = resolvePackReviewStageClaimNamespace(input);
  const result = acquireReviewStartClaim({
    ...input,
    namespace,
    holderContext: {
      ...(input.holderContext ?? {}),
      stage: PACK_REVIEW_STAGE,
    },
  });
  if (result.acquired && result.claim) {
    const fields: PackReviewStageClaimFields = {
      stage: PACK_REVIEW_STAGE,
      turnState: 'none',
    };
    updateReviewStartClaimRecordFields(result, fields as unknown as UnknownRecord);
    const refreshed = readClaimRecord(result.path!);
    if (refreshed.ok && refreshed.record) {
      result.claim = refreshed.record;
    }
  }
  return { ...result, namespace };
}

export function updatePackReviewStageClaimFields(
  claim: ClaimResult,
  fields: Partial<PackReviewStageClaimFields>,
): UnknownRecord {
  return updateReviewStartClaimRecordFields(claim, {
    stage: PACK_REVIEW_STAGE,
    ...fields,
  } as UnknownRecord);
}

export function isGenericRunnerClaimPath(path: string, namespace: string): boolean {
  const resolvedNamespace = resolveReviewStartClaimNamespace({});
  const stageNamespace = resolvePackReviewStageClaimNamespace({});
  const normalized = asString(path);
  return normalized.startsWith(resolvedNamespace) && !normalized.startsWith(stageNamespace);
}

export function isPackReviewStageClaimPath(path: string): boolean {
  return asString(path).includes(`/${PACK_REVIEW_STAGE_SUBDIR}/`);
}

export function extractPackReviewStageFields(record: ReviewStartClaimRecord | undefined): PackReviewStageClaimFields | null {
  if (!record) return null;
  const stage = asString(record.stage);
  if (stage && stage !== PACK_REVIEW_STAGE) return null;
  const turnState = asString(record.turnState) as PackReviewTurnState;
  return {
    stage: PACK_REVIEW_STAGE,
    turnState: turnState || 'none',
    invocationId: asString(record.invocationId) || undefined,
    chatUrl: asString(record.chatUrl) || undefined,
    replyPath: asString(record.replyPath) || undefined,
    workDir: asString(record.workDir) || undefined,
    childPid: Number(record.childPid) > 0 ? Number(record.childPid) : undefined,
    remediationCompleted: record.remediationCompleted === true,
    provenNonDelivery: asRecord(record.provenNonDelivery).scope
      ? {
        scope: asString(asRecord(record.provenNonDelivery).scope),
        cause: asString(asRecord(record.provenNonDelivery).cause),
        phase: asString(asRecord(record.provenNonDelivery).phase) || undefined,
        remediatedAtUtc: asString(asRecord(record.provenNonDelivery).remediatedAtUtc) || undefined,
      }
      : undefined,
  };
}

export function establishPriorTurnState(input: {
  claimRead: ReturnType<typeof readPackReviewStageClaim>;
  childAlive?: (pid: number) => boolean;
  replyExists?: (path: string) => boolean;
}): EstablishedPriorTurnState {
  const childAlive = input.childAlive ?? ((pid: number) => {
    if (pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const replyExists = input.replyExists ?? (() => false);

  if (!input.claimRead.ok) {
    if (input.claimRead.reason === 'missing') return 'B1';
    return 'unknown';
  }

  const fields = extractPackReviewStageFields(input.claimRead.record);
  if (!fields) return 'unknown';

  if (fields.turnState === 'completed' && fields.replyPath && replyExists(fields.replyPath)) {
    return 'B4';
  }
  if (fields.turnState === 'proven_non_delivery' && fields.remediationCompleted) {
    return 'B5';
  }
  if (fields.turnState === 'possible_delivery') {
    return 'B3';
  }
  if (fields.turnState === 'live' || (fields.childPid && childAlive(fields.childPid))) {
    return 'B2';
  }
  if (fields.turnState === 'none' && input.claimRead.record.state === 'active') {
    return 'B2';
  }
  return 'unknown';
}
