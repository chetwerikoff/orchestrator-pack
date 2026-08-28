import './toolchain/native-entrypoint-preflight.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  derivePackReviewGptCoverage,
  listPackReviewRunRecordsReadonly,
  resolvePackReviewRunOrder,
  resolvePackReviewRunStoreRoot,
  type PackReviewRunRecord,
  type PackReviewSourceSlotRecord,
} from './lib/pack-review-run-store.ts';
import {
  createPackGptSourceCommentTransport,
  resolvePackGptSourceComment,
  resolvePackGptSourceCommentForHead,
  type PackGptSourceCommentTransport,
} from './lib/pack-gpt-source-comment.ts';
import {
  createGithubReviewTransport,
  listCanonicalDirectPackReviews,
  type GithubReviewTransport,
} from './lib/github-review-reconciliation.ts';
import { resolveHeadSha, resolveRepositorySlug } from './lib/pack-gpt-reviewer.ts';
import { readStateLightTurnObservation } from './chatgpt-browser-turn/state-light-turn-observation.ts';
import {
  runProbe,
  type InspectionSnapshot,
  type ParsedArgs as ProbeArgs,
} from './browser-gpt-page-probe.ts';

export const PACK_REVIEW_NO_REVIEW_RECONCILIATION_SCHEMA = 'pack-review-no-review-reconciliation/v1' as const;
export type NoReviewDisposition =
  | 'review-present'
  | 'no-completed-review'
  | 'contradiction'
  | 'unavailable/inconclusive';

export interface NoReviewReconciliationInput {
  sourceRepoRoot: string;
  repoSlug: string;
  prNumber: number;
  headSha: string;
  projectId?: string;
  storeRoot?: string;
}

export interface NoReviewReconciliationReceipt {
  schema: typeof PACK_REVIEW_NO_REVIEW_RECONCILIATION_SCHEMA;
  repository: string;
  prNumber: number;
  headSha: string;
  disposition: NoReviewDisposition;
  workflowAuthority: 'none';
  operationalFacts: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  reason: string;
  generatedAtUtc: string;
}

export interface NoReviewReconciliationDependencies {
  now: () => Date;
  readCurrentHead: (repoRoot: string, prNumber: number, repoSlug: string) => Promise<string>;
  listRuns: (options: { projectId: string; storeRoot: string }) => PackReviewRunRecord[];
  resolveRunRepository: (run: PackReviewRunRecord) => Promise<
    { ok: true; slug: string } | { ok: false; reason: string }
  >;
  sourceCommentTransport: (input: NoReviewReconciliationInput) => PackGptSourceCommentTransport;
  githubReviewTransport: (input: NoReviewReconciliationInput) => GithubReviewTransport;
  readObservation: (profileKey: string, invocationId: string) => ReturnType<typeof readStateLightTurnObservation>;
  probe: (args: ProbeArgs) => Promise<Record<string, unknown>>;
}

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function bounded(value: unknown, limit = 240): string {
  return Array.from(trim(value)).slice(0, limit).join('');
}

function normalizeInput(input: NoReviewReconciliationInput): NoReviewReconciliationInput & { projectId: string } {
  const repoSlug = trim(input.repoSlug);
  const sourceRepoRoot = trim(input.sourceRepoRoot);
  const headSha = trim(input.headSha).toLowerCase();
  const projectId = trim(input.projectId) || 'orchestrator-pack';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoSlug)) throw new Error('invalid_repository');
  if (!sourceRepoRoot) throw new Error('invalid_source_repo_root');
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) throw new Error('invalid_pr_number');
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('invalid_head_sha');
  return { ...input, sourceRepoRoot, repoSlug, headSha, projectId };
}

function receipt(
  input: NoReviewReconciliationInput & { projectId: string },
  disposition: NoReviewDisposition,
  reason: string,
  operationalFacts: Array<Record<string, unknown>>,
  evidence: Array<Record<string, unknown>>,
  now: Date,
): NoReviewReconciliationReceipt {
  return {
    schema: PACK_REVIEW_NO_REVIEW_RECONCILIATION_SCHEMA,
    repository: input.repoSlug,
    prNumber: input.prNumber,
    headSha: input.headSha,
    disposition,
    workflowAuthority: 'none',
    operationalFacts: operationalFacts.slice(0, 64),
    evidence: evidence.slice(0, 64),
    reason: bounded(reason),
    generatedAtUtc: now.toISOString(),
  };
}

function terminalRecord(slot: PackReviewSourceSlotRecord): Record<string, unknown> {
  return slot.terminalResult && typeof slot.terminalResult === 'object' && !Array.isArray(slot.terminalResult)
    ? slot.terminalResult as Record<string, unknown>
    : {};
}

function slotFact(slot: PackReviewSourceSlotRecord): Record<string, unknown> {
  const terminal = terminalRecord(slot);
  return {
    sourceSlotId: slot.slotId,
    lifecycle: slot.lifecycle,
    ...(slot.terminalClass ? { terminalClass: slot.terminalClass } : {}),
    ...(slot.invocationId ? { invocationId: slot.invocationId } : {}),
    sendCount: Number.isInteger(terminal.send_count) ? terminal.send_count : null,
    timedOut: terminal.process_timed_out === true || terminal.process_exit_code === 124,
    cancelled: terminal.process_cancelled === true,
    ...(terminal.cause ? { reason: bounded(terminal.cause) } : {}),
  };
}

function authoritativePreSend(slot: PackReviewSourceSlotRecord): boolean {
  if (slot.lifecycle === 'planned' && !slot.invocationId) return true;
  const terminal = terminalRecord(slot);
  if (terminal.send_count === 0) return true;
  if (terminal.state === 'not_sent') return true;
  if (slot.terminalClass === 'pre_launch_interrupted') return true;
  if ((slot.terminalClass ?? '').startsWith('explicit_refusal:zero_send_')) return true;
  return false;
}

function profileAndCdp(slot: PackReviewSourceSlotRecord): { profileKey: string; cdp: string } | null {
  const terminal = terminalRecord(slot);
  const profileKey = trim(terminal.configured_profile_key ?? terminal.profile_key);
  const cdp = trim(
    terminal.configured_cdp_url
      ?? terminal.configured_cdp
      ?? terminal.cdp_url
      ?? terminal.cdp,
  );
  return profileKey && cdp ? { profileKey, cdp } : null;
}

function exactOwnedUser(snapshot: InspectionSnapshot, marker: string) {
  if (snapshot.nodes_truncated) return { kind: 'inconclusive' as const, reason: 'owned_marker_census_truncated' };
  const matches = snapshot.nodes.filter((node) => (
    node.role === 'user'
    && (node.innerText.head.includes(marker)
      || node.innerText.tail.includes(marker)
      || node.textContent.head.includes(marker)
      || node.textContent.tail.includes(marker))
  ));
  if (matches.length !== 1) {
    return {
      kind: 'inconclusive' as const,
      reason: matches.length === 0 ? 'owned_marker_user_carrier_missing' : 'owned_marker_user_carrier_ambiguous',
    };
  }
  return { kind: 'found' as const, node: matches[0]! };
}

function assistantForOwnedUser(snapshot: InspectionSnapshot, userDocumentOrdinal: number) {
  const after = [...snapshot.nodes]
    .filter((node) => node.document_ordinal > userDocumentOrdinal)
    .sort((left, right) => left.document_ordinal - right.document_ordinal);
  const untilNextUser = after.slice(0, after.findIndex((node) => node.role === 'user') < 0
    ? after.length
    : after.findIndex((node) => node.role === 'user'));
  const assistants = untilNextUser.filter((node) => node.role === 'assistant');
  if (assistants.length > 1) return { kind: 'ambiguous' as const };
  return assistants.length === 1
    ? { kind: 'found' as const, node: assistants[0]! }
    : { kind: 'missing' as const };
}

async function reconcilePossibleDelivery(
  slot: PackReviewSourceSlotRecord,
  deps: NoReviewReconciliationDependencies,
): Promise<{ disposition: NoReviewDisposition | 'slot-closed'; reason: string; evidence: Record<string, unknown> }> {
  const invocationId = trim(slot.invocationId);
  if (!invocationId) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'possible_delivery_invocation_unbound',
      evidence: slotFact(slot),
    };
  }
  const binding = profileAndCdp(slot);
  if (!binding) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'possible_delivery_profile_or_cdp_unproven',
      evidence: slotFact(slot),
    };
  }

  let observation: ReturnType<typeof readStateLightTurnObservation>;
  try {
    observation = deps.readObservation(binding.profileKey, invocationId);
  } catch (error) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_observation_unavailable',
      evidence: { ...slotFact(slot), detail: bounded(error) },
    };
  }
  if (observation.profile_key !== binding.profileKey || observation.invocation_id !== invocationId) {
    return {
      disposition: 'contradiction',
      reason: 'owned_turn_observation_identity_mismatch',
      evidence: slotFact(slot),
    };
  }
  if (observation.phase === 'not_sent' || observation.send_count === 0) {
    return {
      disposition: 'slot-closed',
      reason: 'owned_turn_observation_proves_not_sent',
      evidence: { ...slotFact(slot), observationPhase: observation.phase },
    };
  }
  if (!observation.conversation_url) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_conversation_unbound',
      evidence: { ...slotFact(slot), observationPhase: observation.phase },
    };
  }

  let inspected: Record<string, unknown>;
  try {
    inspected = await deps.probe({
      operation: 'inspect',
      cdp: binding.cdp,
      conversationUrl: observation.conversation_url,
    });
  } catch (error) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_inspection_unavailable',
      evidence: { ...slotFact(slot), detail: bounded(error) },
    };
  }
  if (inspected.status !== 'ok'
      || !inspected.snapshot
      || typeof inspected.snapshot !== 'object'
      || Array.isArray(inspected.snapshot)) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_inspection_inconclusive',
      evidence: { ...slotFact(slot), probeStatus: bounded(inspected.status) },
    };
  }
  const snapshot = inspected.snapshot as unknown as InspectionSnapshot;
  const owned = exactOwnedUser(snapshot, observation.marker);
  if (owned.kind !== 'found') {
    return {
      disposition: 'unavailable/inconclusive',
      reason: owned.reason,
      evidence: { ...slotFact(slot), observationPhase: observation.phase },
    };
  }
  const assistant = assistantForOwnedUser(snapshot, owned.node.document_ordinal);
  if (assistant.kind === 'ambiguous') {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_assistant_ambiguous',
      evidence: slotFact(slot),
    };
  }
  if (assistant.kind === 'missing') {
    if (snapshot.generation_in_progress === false) {
      return {
        disposition: 'slot-closed',
        reason: 'owned_turn_stably_has_no_assistant_result',
        evidence: {
          ...slotFact(slot),
          observationPhase: observation.phase,
          conversationUrl: observation.conversation_url,
        },
      };
    }
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_generation_not_settled',
      evidence: { ...slotFact(slot), generationInProgress: snapshot.generation_in_progress },
    };
  }

  const assistantSummary = assistant.node.innerText;
  if (observation.primary
      && (assistantSummary.byte_length !== observation.primary.byte_length
        || assistantSummary.sha256 !== observation.primary.sha256)) {
    return {
      disposition: 'contradiction',
      reason: 'owned_turn_assistant_primary_mismatch',
      evidence: {
        ...slotFact(slot),
        observedSha256: assistantSummary.sha256,
        primarySha256: observation.primary.sha256,
      },
    };
  }

  const targetId = trim(inspected.target_id);
  if (!targetId) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_target_id_unavailable',
      evidence: slotFact(slot),
    };
  }
  const temp = mkdtempSync(join(tmpdir(), 'opk-no-review-export-'));
  const output = join(temp, 'assistant.txt');
  try {
    const exported = await deps.probe({
      operation: 'export',
      cdp: binding.cdp,
      targetId,
      role: 'assistant',
      ordinal: assistant.node.ordinal,
      ...(assistant.node.message_id && assistant.node.message_id_unique
        ? { messageId: assistant.node.message_id }
        : {}),
      representation: 'innerText',
      expectedByteLength: assistantSummary.byte_length,
      expectedSha256: assistantSummary.sha256,
      output,
    });
    if (exported.status !== 'ok') {
      return {
        disposition: 'unavailable/inconclusive',
        reason: 'owned_turn_export_inconclusive',
        evidence: { ...slotFact(slot), probeStatus: bounded(exported.status) },
      };
    }
    const bytes = readFileSync(output);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== assistantSummary.byte_length || sha256 !== assistantSummary.sha256) {
      return {
        disposition: 'contradiction',
        reason: 'owned_turn_export_snapshot_mismatch',
        evidence: { ...slotFact(slot), exportedSha256: sha256, snapshotSha256: assistantSummary.sha256 },
      };
    }
    if (observation.primary
        && (bytes.byteLength !== observation.primary.byte_length || sha256 !== observation.primary.sha256)) {
      return {
        disposition: 'contradiction',
        reason: 'owned_turn_export_primary_mismatch',
        evidence: { ...slotFact(slot), exportedSha256: sha256, primarySha256: observation.primary.sha256 },
      };
    }
    return {
      disposition: 'review-present',
      reason: 'owned_turn_assistant_result_present',
      evidence: {
        ...slotFact(slot),
        conversationUrl: bounded(observation.conversation_url, 512),
        assistantSha256: sha256,
        primaryBound: Boolean(observation.primary),
      },
    };
  } catch (error) {
    return {
      disposition: 'unavailable/inconclusive',
      reason: 'owned_turn_export_unavailable',
      evidence: { ...slotFact(slot), detail: bounded(error) },
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function githubReviewEvidence(
  input: NoReviewReconciliationInput & { projectId: string },
  deps: NoReviewReconciliationDependencies,
): Promise<{ kind: 'present' | 'absent' | 'inconclusive'; evidence: Record<string, unknown>; reason: string }> {
  let transport: GithubReviewTransport;
  try {
    transport = deps.githubReviewTransport(input);
    const owner = input.repoSlug.split('/', 1)[0] ?? '';
    if (!owner) return { kind: 'inconclusive', reason: 'github_review_owner_resolution_empty', evidence: {} };
    const reviews = await transport.listReviews();
    const canonical = listCanonicalDirectPackReviews(reviews, owner)
      .filter((review) => review.headSha.toLowerCase() === input.headSha);
    if (canonical.length > 0) {
      return {
        kind: 'present',
        reason: 'canonical_exact_head_github_review_present',
        evidence: {
          canonicalReviewCount: canonical.length,
          reviewIds: canonical.slice(0, 16).map((review) => review.reviewId),
        },
      };
    }
    return { kind: 'absent', reason: 'canonical_exact_head_github_review_absent', evidence: { reviewCount: reviews.length } };
  } catch (error) {
    return {
      kind: 'inconclusive',
      reason: 'github_review_census_unavailable',
      evidence: { detail: bounded(error) },
    };
  }
}

function defaultDependencies(): NoReviewReconciliationDependencies {
  return {
    now: () => new Date(),
    readCurrentHead: resolveHeadSha,
    listRuns: (options) => listPackReviewRunRecordsReadonly(options),
    resolveRunRepository: async (run) => {
      if (trim(run.canonicalRepository)) return { ok: true, slug: trim(run.canonicalRepository) };
      if (!trim(run.sourceRepoRoot)) return { ok: false, reason: 'legacy_repository_unresolved' };
      try {
        const slug = await resolveRepositorySlug(run.sourceRepoRoot);
        return /^[^/\s]+\/[^/\s]+$/.test(slug)
          ? { ok: true, slug }
          : { ok: false, reason: 'legacy_repository_ambiguous' };
      } catch {
        return { ok: false, reason: 'legacy_repository_unresolved' };
      }
    },
    sourceCommentTransport: (input) => createPackGptSourceCommentTransport({
      repoRoot: input.sourceRepoRoot,
      repoSlug: input.repoSlug,
      prNumber: input.prNumber,
    }),
    githubReviewTransport: (input) => createGithubReviewTransport({
      repoRoot: input.sourceRepoRoot,
      repoSlug: input.repoSlug,
      prNumber: input.prNumber,
    }),
    readObservation: readStateLightTurnObservation,
    probe: async (args) => runProbe(args) as unknown as Record<string, unknown>,
  };
}

function latestRun(
  records: readonly PackReviewRunRecord[],
): { run?: PackReviewRunRecord; reason?: string } {
  if (records.length === 0) return {};
  const candidates = records.filter((candidate) => (
    resolvePackReviewRunOrder(records, candidate).kind === 'none'
  ));
  if (candidates.length !== 1) return { reason: 'matching_run_order_ambiguous' };
  const order = resolvePackReviewRunOrder(records, candidates[0]!);
  if (order.kind === 'ambiguous') return { reason: order.reason };
  return { run: candidates[0]! };
}

export async function reconcilePackReviewNoReview(
  rawInput: NoReviewReconciliationInput,
  overrides: Partial<NoReviewReconciliationDependencies> = {},
): Promise<NoReviewReconciliationReceipt> {
  const input = normalizeInput(rawInput);
  const defaults = defaultDependencies();
  const deps = { ...defaults, ...overrides };
  const operationalFacts: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const finish = (disposition: NoReviewDisposition, reason: string) => (
    receipt(input, disposition, reason, operationalFacts, evidence, deps.now())
  );

  let liveHead: string;
  try {
    liveHead = trim(await deps.readCurrentHead(input.sourceRepoRoot, input.prNumber, input.repoSlug)).toLowerCase();
  } catch (error) {
    evidence.push({ kind: 'head-census', state: 'unavailable', detail: bounded(error) });
    return finish('unavailable/inconclusive', 'live_pr_head_unavailable');
  }
  if (liveHead !== input.headSha) {
    evidence.push({ kind: 'head-census', state: 'changed', liveHead: bounded(liveHead, 64) });
    return finish('unavailable/inconclusive', 'receipt_head_is_stale');
  }
  operationalFacts.push({ kind: 'head-binding', state: 'exact', headSha: input.headSha });

  const storeRoot = resolvePackReviewRunStoreRoot({ projectId: input.projectId, storeRoot: input.storeRoot });
  operationalFacts.push({ kind: 'run-store', inspectedRoot: storeRoot, exhaustiveness: 'unproven' });

  let sameHeadRows: PackReviewRunRecord[];
  try {
    sameHeadRows = deps.listRuns({ projectId: input.projectId, storeRoot })
      .filter((run) => run.prNumber === input.prNumber && run.targetSha.toLowerCase() === input.headSha);
  } catch (error) {
    evidence.push({ kind: 'run-store-census', state: 'unavailable', detail: bounded(error) });
    return finish('unavailable/inconclusive', 'run_store_census_unavailable');
  }
  operationalFacts.push({ kind: 'run-store-census', sameProjectPrHeadRows: sameHeadRows.length });

  const targetRows: PackReviewRunRecord[] = [];
  for (const row of sameHeadRows) {
    let identity: Awaited<ReturnType<NoReviewReconciliationDependencies['resolveRunRepository']>>;
    try {
      identity = await deps.resolveRunRepository(row);
    } catch (error) {
      evidence.push({ kind: 'run-repository', runId: row.id, state: 'unavailable', detail: bounded(error) });
      return finish('unavailable/inconclusive', 'repository_identity_unresolved');
    }
    if (!identity.ok) {
      evidence.push({ kind: 'run-repository', runId: row.id, state: 'unresolved', reason: bounded(identity.reason) });
      return finish('unavailable/inconclusive',
        identity.reason.includes('ambiguous') ? 'repository_identity_ambiguous' : 'repository_identity_unresolved');
    }
    if (identity.slug === input.repoSlug) targetRows.push(row);
  }

  const selected = latestRun(targetRows);
  if (selected.reason) {
    evidence.push({ kind: 'run-selection', state: 'ambiguous', reason: selected.reason });
    return finish('unavailable/inconclusive', selected.reason);
  }
  const run = selected.run;

  if (!run) {
    let transport: PackGptSourceCommentTransport;
    try {
      transport = deps.sourceCommentTransport(input);
    } catch (error) {
      evidence.push({ kind: 'source-comment-transport', state: 'unavailable', detail: bounded(error) });
      return finish('unavailable/inconclusive', 'source_comment_transport_unavailable');
    }
    operationalFacts.push({ kind: 'run-selection', state: 'no-matching-local-run-in-inspected-root' });
    let sourceResolution;
    try {
      sourceResolution = await resolvePackGptSourceCommentForHead({
        repository: input.repoSlug,
        prNumber: input.prNumber,
        headSha: input.headSha,
        transport,
      });
    } catch (error) {
      evidence.push({ kind: 'source-comment-census', state: 'unavailable', detail: bounded(error) });
      return finish('unavailable/inconclusive', 'source_comment_census_unavailable');
    }
    evidence.push({
      kind: 'source-comment-census',
      state: sourceResolution.kind,
      ...('reason' in sourceResolution ? { reason: sourceResolution.reason } : {}),
    });
    if (sourceResolution.kind === 'credentialed') {
      evidence.push({
        kind: 'source-comment',
        runId: sourceResolution.identity.runId,
        sourceSlotId: sourceResolution.identity.slotId,
        invocationId: sourceResolution.identity.invocationId,
        commentId: sourceResolution.receipt.commentId,
      });
      return finish('review-present', 'exact_head_source_comment_present');
    }
    if (sourceResolution.kind !== 'missing') {
      return finish('unavailable/inconclusive', sourceResolution.reason);
    }

    const github = await githubReviewEvidence(input, deps);
    evidence.push({ kind: 'github-review-census', state: github.kind, reason: github.reason, ...github.evidence });
    if (github.kind === 'present') return finish('review-present', github.reason);
    if (github.kind === 'inconclusive') return finish('unavailable/inconclusive', github.reason);

    // Current authority cannot prove that the selected run-store root is an
    // exhaustive census. Never scan alternate roots or start a reviewer here.
    return finish('unavailable/inconclusive', 'run_store_census_not_exhaustive');
  }

  operationalFacts.push({ kind: 'run-selection', state: 'matched', runId: run.id });
  const coverage = derivePackReviewGptCoverage(run.reviewRound);
  if (!coverage) {
    evidence.push({ kind: 'coverage', state: 'unavailable', runId: run.id });
    return finish('unavailable/inconclusive', 'matching_run_has_no_gpt_round');
  }
  evidence.push({
    kind: 'coverage',
    coverage: coverage.kind,
    completedSourceCount: coverage.completedSourceCount,
    cardinality: coverage.cardinality,
    completedSourceSlotIds: coverage.completedSourceSlotIds,
    incompleteSources: coverage.incompleteSources.slice(0, 16),
  });
  if (coverage.completedSourceCount > 0) {
    return finish('review-present', 'matching_run_has_completed_source');
  }

  if (!run.reviewRound) return finish('unavailable/inconclusive', 'matching_run_has_no_gpt_round');

  let transport: PackGptSourceCommentTransport;
  try {
    transport = deps.sourceCommentTransport(input);
  } catch (error) {
    evidence.push({ kind: 'source-comment-transport', state: 'unavailable', detail: bounded(error) });
    return finish('unavailable/inconclusive', 'source_comment_transport_unavailable');
  }

  for (const slot of run.reviewRound.sourceSlots) {
    const invocationId = trim(slot.invocationId);
    if (!invocationId) continue;
    const identity = {
      repository: input.repoSlug,
      prNumber: input.prNumber,
      headSha: input.headSha,
      runId: run.id,
      slotId: slot.slotId,
      invocationId,
    };
    let sourceResolution;
    try {
      sourceResolution = await resolvePackGptSourceComment({ identity, transport });
    } catch (error) {
      evidence.push({ kind: 'source-comment', sourceSlotId: slot.slotId, state: 'unavailable', detail: bounded(error) });
      return finish('unavailable/inconclusive', 'source_comment_census_unavailable');
    }
    evidence.push({
      kind: 'source-comment',
      sourceSlotId: slot.slotId,
      state: sourceResolution.kind,
      ...('reason' in sourceResolution ? { reason: sourceResolution.reason } : {}),
      ...(sourceResolution.kind === 'credentialed' ? { commentId: sourceResolution.receipt.commentId } : {}),
    });
    if (sourceResolution.kind === 'credentialed') {
      return finish('review-present', 'matching_run_source_comment_present');
    }
    if (sourceResolution.kind !== 'missing') {
      return finish('unavailable/inconclusive', sourceResolution.reason);
    }
  }

  const github = await githubReviewEvidence(input, deps);
  evidence.push({ kind: 'github-review-census', state: github.kind, reason: github.reason, ...github.evidence });
  if (github.kind === 'present') return finish('review-present', github.reason);
  if (github.kind === 'inconclusive') return finish('unavailable/inconclusive', github.reason);

  for (const slot of run.reviewRound.sourceSlots) {
    if (authoritativePreSend(slot)) {
      evidence.push({ kind: 'slot-closure', state: 'closed-pre-send', ...slotFact(slot) });
      continue;
    }
    const possible = await reconcilePossibleDelivery(slot, deps);
    evidence.push({ kind: 'slot-closure', state: possible.disposition, reason: possible.reason, ...possible.evidence });
    if (possible.disposition === 'slot-closed') continue;
    if (possible.disposition === 'review-present') return finish('review-present', possible.reason);
    if (possible.disposition === 'contradiction') return finish('contradiction', possible.reason);
    return finish('unavailable/inconclusive', possible.reason);
  }

  return finish('no-completed-review', 'matching_run_all_incomplete_slots_closed_negative');
}

function parseArgs(argv: readonly string[]): NoReviewReconciliationInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid_arguments');
    values.set(key, value);
  }
  return {
    sourceRepoRoot: values.get('--source-repo-root') ?? '',
    repoSlug: values.get('--repo-slug') ?? '',
    prNumber: Number(values.get('--pr-number') ?? 0),
    headSha: values.get('--head-sha') ?? '',
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let input: NoReviewReconciliationInput;
  try {
    input = parseArgs(argv);
    const result = await reconcilePackReviewNoReview(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const repoSlug = argv[argv.indexOf('--repo-slug') + 1] ?? 'unknown/unknown';
    const prNumber = Number(argv[argv.indexOf('--pr-number') + 1] ?? 0);
    const headSha = trim(argv[argv.indexOf('--head-sha') + 1]).toLowerCase();
    const fallback: NoReviewReconciliationReceipt = {
      schema: PACK_REVIEW_NO_REVIEW_RECONCILIATION_SCHEMA,
      repository: /^[^/\s]+\/[^/\s]+$/.test(repoSlug) ? repoSlug : 'unknown/unknown',
      prNumber: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : 1,
      headSha: /^[0-9a-f]{40}$/.test(headSha) ? headSha : '0'.repeat(40),
      disposition: 'unavailable/inconclusive',
      workflowAuthority: 'none',
      operationalFacts: [],
      evidence: [{ kind: 'producer-error', detail: bounded(error) }],
      reason: 'producer_unavailable',
      generatedAtUtc: new Date().toISOString(),
    };
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
