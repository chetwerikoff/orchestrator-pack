#!/usr/bin/env node
/**
 * Public merge-triage entrypoint.
 *
 * The mature Issue #648 implementation remains byte-identical in
 * `merge-triage-gate-core.mjs`. This wrapper preserves its public exports and CLI while
 * adding the Issue #933 direct-operator decision: an active approval for the exact
 * repository/PR/head is a fail-closed merge-policy result, never an implicit payload bypass.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readStdinJson, printJson } from './review-mechanical-cli.mjs';

const originalCliEntry = process.argv[1];
process.argv[1] = 'merge-triage-gate-core-import.mjs';
let core;
try {
  core = await import('./merge-triage-gate-core.mjs');
} finally {
  process.argv[1] = originalCliEntry;
}

export const TRIAGE_SCHEMA_VERSION = core.TRIAGE_SCHEMA_VERSION;
export const TERMINAL_AT_CAP_OPEN_FINDINGS = core.TERMINAL_AT_CAP_OPEN_FINDINGS;
export const TERMINAL_CLEAN_EARLY_STOP = core.TERMINAL_CLEAN_EARLY_STOP;
export const TERMINAL_MERGE_TRIAGE_CLEARED = core.TERMINAL_MERGE_TRIAGE_CLEARED;
export const VERDICT_BLOCK = core.VERDICT_BLOCK;
export const VERDICT_DEFER = core.VERDICT_DEFER;
export const VERDICT_PENDING_ARCHITECT = core.VERDICT_PENDING_ARCHITECT;
export const VERDICT_PENDING_OPERATOR = core.VERDICT_PENDING_OPERATOR;
export const VERDICT_ACK_RESET = core.VERDICT_ACK_RESET;
export const DEFAULT_MARKER_FILE = core.DEFAULT_MARKER_FILE;

export const sha256 = core.sha256;
export const normalizeTriageText = core.normalizeTriageText;
export const buildFindingText = core.buildFindingText;
export const loadMarkerList = core.loadMarkerList;
export const classifyFinding = core.classifyFinding;
export const resolveStateRoot = core.resolveStateRoot;
export const ensureDir = core.ensureDir;
export const readPackFindingStore = core.readPackFindingStore;
export const computeOpenFindingsSnapshotHash = core.computeOpenFindingsSnapshotHash;
export const readArchitectInbox = core.readArchitectInbox;
export const issueArchitectProvenanceToken = core.issueArchitectProvenanceToken;
export const fileWorkerAppeal = core.fileWorkerAppeal;
export const adjudicateArchitectFinding = core.adjudicateArchitectFinding;
export const acknowledgeArchitectPermissiveBudget = core.acknowledgeArchitectPermissiveBudget;

const OPERATOR_APPROVAL_SCHEMA_VERSION = 1;
const OPERATOR_APPROVAL_EVENT = 'operator_merge_approved';
const CANONICAL_ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PACK_REVIEW_REQUIRED_STATUS_CONTEXT = 'orchestrator-pack/pack-review';
const PACK_REVIEW_TERMINAL_STATUSES = new Set(['up_to_date', 'commented', 'changes_requested']);

function normalizeProjectId(value = 'orchestrator-pack') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return normalized || null;
}

function normalizeRepoSlug(value) {
  const repoSlug = String(value ?? '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(repoSlug) ? repoSlug : null;
}

function isCanonicalIsoTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!CANONICAL_ISO_UTC_PATTERN.test(text)) return false;
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === text;
}

function resolveDirectOperatorSessionKind() {
  const sessionId = String(process.env.AO_SESSION_ID ?? '').trim();
  const envKind = normalizeTriageText(process.env.AO_SESSION_KIND ?? '');
  if (sessionId) {
    return { ok: false, reason: 'ao_managed_session_forbidden' };
  }
  if (!envKind) {
    return { ok: false, reason: 'operator_session_kind_missing' };
  }
  return envKind === 'operator'
    ? { ok: true, kind: envKind }
    : { ok: false, reason: 'session_kind_not_operator' };
}

function operatorApprovalRecordPath(input, prNumber) {
  const projectId = normalizeProjectId(input.projectId ?? 'orchestrator-pack');
  if (!projectId) return null;
  return path.join(
    resolveStateRoot(input),
    'operator-merge-approvals',
    projectId,
    `pr-${prNumber}.json`,
  );
}

function readExactHeadOperatorApproval(input = {}) {
  if (input.directOperatorMerge !== true) {
    return { applicable: false, approved: false, reason: 'not_direct_operator_merge' };
  }

  const session = resolveDirectOperatorSessionKind();
  if (!session.ok) return { applicable: true, approved: false, reason: session.reason };

  const projectId = normalizeProjectId(input.projectId ?? 'orchestrator-pack');
  const repoSlug = normalizeRepoSlug(input.repoSlug);
  const prNumber = Number(input.prNumber);
  const headSha = String(input.headSha ?? input.currentHeadSha ?? '').trim().toLowerCase();
  if (!projectId) return { applicable: true, approved: false, reason: 'project_id_invalid' };
  if (!repoSlug) return { applicable: true, approved: false, reason: 'repo_slug_invalid' };
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { applicable: true, approved: false, reason: 'pr_number_invalid' };
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    return { applicable: true, approved: false, reason: 'head_sha_invalid' };
  }

  const recordPath = operatorApprovalRecordPath(input, prNumber);
  if (!recordPath || !existsSync(recordPath)) {
    return { applicable: true, approved: false, reason: 'approval_missing' };
  }

  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  if (
    Number(record.schemaVersion) !== OPERATOR_APPROVAL_SCHEMA_VERSION ||
    record.event !== OPERATOR_APPROVAL_EVENT ||
    !String(record.approvalId ?? '').trim() ||
    !String(record.reason ?? '').trim() ||
    !String(record.actor ?? '').trim() ||
    !isCanonicalIsoTimestamp(record.createdAtUtc)
  ) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  const revokedAtUtc = String(record.revokedAtUtc ?? '').trim();
  const revocationReason = String(record.revocationReason ?? '').trim();
  if (Boolean(revokedAtUtc) !== Boolean(revocationReason)) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  if (revokedAtUtc && !isCanonicalIsoTimestamp(revokedAtUtc)) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  if (String(record.projectId ?? '') !== projectId) {
    return { applicable: true, approved: false, reason: 'approval_project_mismatch', record };
  }
  if (String(record.repoSlug ?? '') !== repoSlug) {
    return { applicable: true, approved: false, reason: 'approval_repository_mismatch', record };
  }
  if (Number(record.prNumber) !== prNumber) {
    return { applicable: true, approved: false, reason: 'approval_pr_mismatch', record };
  }
  if (String(record.headSha ?? '').toLowerCase() !== headSha) {
    return { applicable: true, approved: false, reason: 'approval_head_mismatch', record };
  }
  if (revokedAtUtc) {
    return { applicable: true, approved: false, reason: 'approval_revoked', record };
  }

  return { applicable: true, approved: true, reason: 'approved', record };
}

function resolvePackReviewRunStoreRoot(projectId) {
  const explicit = String(process.env.PACK_REVIEW_RUN_STORE_ROOT ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const stateRoot = String(process.env.ORCHESTRATOR_PACK_STATE_ROOT ?? '').trim();
  if (stateRoot) return path.join(path.resolve(stateRoot), 'review-runs', projectId);
  return path.join(homedir(), '.orchestrator-pack', 'review-runs', projectId);
}

function timestampAtOrBefore(left, right) {
  return Date.parse(left) <= Date.parse(right);
}

function terminalPackReviewEvidence(record, projectId, prNumber, headSha) {
  if (Number(record.schemaVersion) !== 1) return { ok: false, reason: 'schema_version_invalid' };
  const runId = String(record.id ?? record.runId ?? '').trim();
  if (!/^prr-[a-zA-Z0-9._-]+$/.test(runId)) return { ok: false, reason: 'run_id_invalid' };
  if (String(record.projectId ?? '') !== projectId) return { ok: false, reason: 'project_mismatch' };
  if (Number(record.prNumber) !== prNumber) return { ok: false, reason: 'pr_mismatch' };
  const targetSha = String(record.targetSha ?? record.headSha ?? '').trim().toLowerCase();
  if (targetSha !== headSha) return { ok: false, reason: 'head_mismatch' };
  if (String(record.key ?? '') !== `pr-${prNumber}-${headSha}`) return { ok: false, reason: 'key_mismatch' };

  const status = String(record.status ?? '');
  if (!PACK_REVIEW_TERMINAL_STATUSES.has(status) || record.latestRunStatus !== status) {
    return { ok: false, reason: 'run_not_terminal' };
  }
  const completedAtUtc = String(record.completedAtUtc ?? '').trim();
  if (!isCanonicalIsoTimestamp(completedAtUtc)) {
    return { ok: false, reason: 'completed_timestamp_invalid' };
  }

  const findings = Array.isArray(record.findings) ? record.findings : null;
  const findingCount = Number(record.findingCount);
  if (
    (record.reviewVerdict !== 'clean' && record.reviewVerdict !== 'findings') ||
    !findings ||
    !Number.isInteger(findingCount) ||
    findingCount < 0 ||
    findings.length !== findingCount
  ) {
    return { ok: false, reason: 'verdict_payload_invalid' };
  }
  if (status === 'up_to_date' && (record.reviewVerdict !== 'clean' || findingCount !== 0)) {
    return { ok: false, reason: 'terminal_status_verdict_mismatch' };
  }
  if (status !== 'up_to_date' && record.reviewVerdict !== 'findings') {
    return { ok: false, reason: 'terminal_status_verdict_mismatch' };
  }

  const journal = record.journalOutcome;
  const journalKey = `verdict:${runId}:${headSha}`;
  if (
    journal?.state !== 'persisted' ||
    journal.idempotencyKey !== journalKey ||
    !Number.isInteger(Number(journal.attempts)) ||
    Number(journal.attempts) <= 0 ||
    !isCanonicalIsoTimestamp(journal.recordedAtUtc) ||
    !timestampAtOrBefore(journal.recordedAtUtc, completedAtUtc)
  ) {
    return { ok: false, reason: 'journal_not_authoritative' };
  }

  const reconciliation = record.githubReviewReconciliation;
  const githubReviewId = record.githubReviewId ?? reconciliation?.commentReviewId;
  if (
    record.githubReviewEvent !== 'COMMENT' ||
    reconciliation?.event !== 'COMMENT' ||
    reconciliation.phase !== 'complete' ||
    githubReviewId === undefined ||
    !Array.isArray(reconciliation.pendingDismissalReviewIds) ||
    reconciliation.pendingDismissalReviewIds.length > 0 ||
    !Array.isArray(reconciliation.dismissedReviewIds) ||
    !isCanonicalIsoTimestamp(reconciliation.preparedAtUtc) ||
    !timestampAtOrBefore(reconciliation.preparedAtUtc, reconciliation.updatedAtUtc) ||
    !isCanonicalIsoTimestamp(reconciliation.updatedAtUtc) ||
    !timestampAtOrBefore(reconciliation.updatedAtUtc, completedAtUtc)
  ) {
    return { ok: false, reason: 'github_review_not_authoritative' };
  }
  if (
    record.githubReviewId !== undefined &&
    reconciliation.commentReviewId !== undefined &&
    String(record.githubReviewId) !== String(reconciliation.commentReviewId)
  ) {
    return { ok: false, reason: 'github_review_identity_mismatch' };
  }

  const githubOutcome = record.deliveryOutcomes?.githubComment;
  if (
    githubOutcome?.state !== 'succeeded' ||
    githubOutcome.idempotencyKey !== `github-comment:${runId}:${headSha}` ||
    !isCanonicalIsoTimestamp(githubOutcome.recordedAtUtc) ||
    !timestampAtOrBefore(githubOutcome.recordedAtUtc, completedAtUtc)
  ) {
    return { ok: false, reason: 'github_review_delivery_incomplete' };
  }

  const requiredOutcome = record.deliveryOutcomes?.requiredStatus;
  const expectedRequiredReason = status === 'changes_requested' ? 'status_failure' : 'status_success';
  if (
    requiredOutcome?.state !== 'succeeded' ||
    requiredOutcome.reason !== expectedRequiredReason ||
    requiredOutcome.idempotencyKey !== `required-status:${PACK_REVIEW_REQUIRED_STATUS_CONTEXT}:${headSha}` ||
    !isCanonicalIsoTimestamp(requiredOutcome.recordedAtUtc) ||
    !timestampAtOrBefore(requiredOutcome.recordedAtUtc, completedAtUtc)
  ) {
    return { ok: false, reason: 'required_status_delivery_incomplete' };
  }

  return { ok: true, record, findings, timestampMs: Date.parse(completedAtUtc) };
}

function readLatestExactHeadPackReview(projectId, prNumber, headSha) {
  const recordsDir = path.join(resolvePackReviewRunStoreRoot(projectId), 'runs');
  if (!existsSync(recordsDir)) return { ok: false, reason: 'pack_review_store_missing' };

  const matches = [];
  const rejected = [];
  try {
    for (const name of readdirSync(recordsDir)) {
      if (!name.endsWith('.json')) continue;
      const record = JSON.parse(readFileSync(path.join(recordsDir, name), 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return { ok: false, reason: 'pack_review_store_malformed' };
      }
      const recordProject = String(record.projectId ?? '');
      const recordPr = Number(record.prNumber);
      const recordHead = String(record.targetSha ?? record.headSha ?? '').trim().toLowerCase();
      if (recordProject !== projectId || recordPr !== prNumber || recordHead !== headSha) continue;
      const evidence = terminalPackReviewEvidence(record, projectId, prNumber, headSha);
      if (evidence.ok) matches.push(evidence);
      else rejected.push(evidence.reason);
    }
  } catch {
    return { ok: false, reason: 'pack_review_store_malformed' };
  }

  matches.sort((left, right) => right.timestampMs - left.timestampMs);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: rejected.length > 0 ? 'pack_review_terminal_evidence_missing' : 'pack_review_exact_head_missing',
      evidenceReasons: [...new Set(rejected)],
    };
  }
  return matches[0];
}

function directOperatorSafetyResult(input, approval) {
  const projectId = normalizeProjectId(input.projectId ?? 'orchestrator-pack');
  const prNumber = Number(input.prNumber);
  const headSha = String(input.headSha ?? input.currentHeadSha ?? '').trim().toLowerCase();

  let inbox;
  try {
    inbox = core.readArchitectInbox({ ...input, prNumber, headSha });
  } catch {
    return { allow: false, reason: 'operator_merge_pending_state_unavailable' };
  }
  if (!inbox || !Array.isArray(inbox.pending)) {
    return { allow: false, reason: 'operator_merge_pending_state_unavailable' };
  }
  if (inbox.pending.length > 0) {
    return {
      allow: false,
      reason: 'operator_merge_pending_adjudication',
      pending: inbox.pending,
    };
  }

  const review = readLatestExactHeadPackReview(projectId, prNumber, headSha);
  if (!review.ok) {
    return {
      allow: false,
      reason: 'operator_merge_review_findings_unavailable',
      reviewReason: review.reason,
      ...(review.evidenceReasons ? { evidenceReasons: review.evidenceReasons } : {}),
    };
  }

  // Reuse the canonical core policy only when its durable exact-head clearance exists.
  // Caller-supplied terminal/clearance payloads are deliberately excluded: direct mode reads
  // the trusted state root and lets the core validate marker/hash/journal provenance itself.
  const clearancePath = path.join(
    resolveStateRoot(input),
    'merge-triage',
    'clearance',
    `pr-${prNumber}-${headSha}.json`,
  );
  let canonicalPolicy = { allow: false, reason: 'canonical_clearance_missing' };
  if (existsSync(clearancePath)) {
    try {
      canonicalPolicy = core.evaluateMergePolicy({
        stateRoot: resolveStateRoot(input),
        prNumber,
        headSha,
        findings: review.findings,
        markerFile: DEFAULT_MARKER_FILE,
        atCapRecord: {
          terminal: TERMINAL_AT_CAP_OPEN_FINDINGS,
          pr_number: prNumber,
          head_sha: headSha,
        },
      });
    } catch {
      canonicalPolicy = { allow: false, reason: 'canonical_policy_unavailable' };
    }
  }
  const canonicallyCleared = canonicalPolicy?.allow === true
    && canonicalPolicy.reason === 'merge_triage_cleared';

  if (!canonicallyCleared) {
    const classifications = review.findings.map((finding) => core.classifyFinding(finding));
    const block = classifications.filter((classification) => classification.verdict === VERDICT_BLOCK);
    if (block.length > 0) {
      return {
        allow: false,
        reason: 'operator_merge_block_findings',
        reviewRunId: String(review.record.id ?? review.record.runId ?? ''),
        classifications: block,
      };
    }
    const pending = classifications.filter((classification) => (
      classification.verdict === VERDICT_PENDING_ARCHITECT ||
      classification.verdict === VERDICT_PENDING_OPERATOR
    ));
    if (pending.length > 0) {
      return {
        allow: false,
        reason: 'operator_merge_pending_adjudication',
        reviewRunId: String(review.record.id ?? review.record.runId ?? ''),
        classifications: pending,
      };
    }
  }

  return {
    allow: true,
    reason: 'operator_merge_approved',
    approvalId: approval.record.approvalId,
    approvedHeadSha: approval.record.headSha,
    approvalActor: approval.record.actor,
    approvalReason: approval.record.reason,
    reviewRunId: String(review.record.id ?? review.record.runId ?? ''),
    ...(canonicallyCleared ? { canonicalPolicyReason: canonicalPolicy.reason } : {}),
  };
}

function directOperatorPolicyResult(input = {}) {
  const approval = readExactHeadOperatorApproval(input);
  if (!approval.applicable) return null;
  if (!approval.approved) {
    return {
      allow: false,
      reason: 'operator_merge_approval_unavailable',
      approvalReason: approval.reason,
    };
  }
  return directOperatorSafetyResult(input, approval);
}

export function evaluateMergePolicy(input = {}) {
  return directOperatorPolicyResult(input) ?? core.evaluateMergePolicy(input);
}

export function runMergeTriageGate(input = {}) {
  const direct = directOperatorPolicyResult(input);
  if (!direct) return core.runMergeTriageGate(input);
  if (!direct.allow) {
    return {
      ok: false,
      ran: true,
      ...direct,
    };
  }
  return {
    ok: true,
    ran: true,
    reason: direct.reason,
    approvalId: direct.approvalId,
    approvedHeadSha: direct.approvedHeadSha,
    approvalActor: direct.approvalActor,
    approvalReason: direct.approvalReason,
    reviewRunId: direct.reviewRunId,
    ...(direct.canonicalPolicyReason ? { canonicalPolicyReason: direct.canonicalPolicyReason } : {}),
  };
}

const CLI_COMMANDS = [
  'classifyFinding',
  'runGate',
  'evaluateMergePolicy',
  'readArchitectInbox',
  'issueArchitectToken',
  'fileWorkerAppeal',
  'adjudicateArchitectFinding',
  'acknowledgeArchitectBudget',
];

function invokeCliCommand(command, payload) {
  switch (command) {
    case 'classifyFinding': return classifyFinding(payload);
    case 'runGate': return runMergeTriageGate(payload);
    case 'evaluateMergePolicy': return evaluateMergePolicy(payload);
    case 'readArchitectInbox': return readArchitectInbox(payload);
    case 'issueArchitectToken': return issueArchitectProvenanceToken(payload);
    case 'fileWorkerAppeal': return fileWorkerAppeal(payload);
    case 'adjudicateArchitectFinding': return adjudicateArchitectFinding(payload);
    case 'acknowledgeArchitectBudget': return acknowledgeArchitectPermissiveBudget(payload);
    default: throw new Error(`unknown merge triage command: ${String(command ?? '<empty>')}`);
  }
}

function directCliFailure(command, result) {
  if (command === 'evaluateMergePolicy') {
    return String(result?.reason ?? '').startsWith('operator_merge_') && result?.allow !== true;
  }
  if (command !== 'runGate' || result?.ok !== false || result?.ran !== true) return false;
  if (String(result?.reason ?? '').startsWith('operator_merge_')) return true;
  if (result.reason === 'open_findings_unavailable') return true;
  return Array.isArray(result.classifications)
    && result.classifications.some((classification) => classification?.reason === 'empty_finding_text');
}

function isPublicCliInvocation(entry) {
  return /(?:^|[\\/])merge-triage-gate\.(?:mjs|js)$/.test(String(entry ?? ''));
}

if (isPublicCliInvocation(process.argv[1])) {
  const command = process.argv[2];
  if (!CLI_COMMANDS.includes(command)) {
    console.error(`Usage: node merge-triage-gate.mjs <${CLI_COMMANDS.join('|')}>`);
    process.exit(2);
  }
  try {
    const result = invokeCliCommand(command, readStdinJson());
    printJson(result);
    process.exit(directCliFailure(command, result) ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
