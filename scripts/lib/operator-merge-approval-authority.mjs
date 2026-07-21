import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { runProcessSync } from '../kernel/subprocess.mjs';

const originalCliEntry = process.argv[1];
process.argv[1] = 'merge-triage-gate-core-authority-import.mjs';
let core;
try {
  core = await import('../../docs/merge-triage-gate-core.mjs');
} finally {
  process.argv[1] = originalCliEntry;
}

const APPROVAL_SCHEMA_VERSION = 1;
const APPROVAL_EVENT = 'operator_merge_approved';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PACK_REVIEW_CONTEXT = 'orchestrator-pack/pack-review';
const TERMINAL_STATUSES = new Set(['up_to_date', 'commented', 'changes_requested']);
const LIVE_REVIEW_FIXTURE_ENV = 'OPK_OPERATOR_MERGE_GITHUB_REVIEW_FIXTURE';

function text(value) {
  return String(value ?? '').trim();
}

function normalizeProjectId(value = 'orchestrator-pack') {
  return text(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || null;
}

function normalizeRepoSlug(value) {
  const slug = text(value);
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

function isIsoUtc(value) {
  const candidate = text(value);
  if (!ISO_UTC.test(candidate)) return false;
  const parsed = new Date(candidate);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === candidate;
}

function sha256(value) {
  return core.sha256(String(value));
}

function resolveSession() {
  if (text(process.env.AO_SESSION_ID)) return { ok: false, reason: 'ao_managed_session_forbidden' };
  const kind = core.normalizeTriageText(process.env.AO_SESSION_KIND ?? '');
  if (!kind) return { ok: false, reason: 'operator_session_kind_missing' };
  return kind === 'operator'
    ? { ok: true, kind }
    : { ok: false, reason: 'session_kind_not_operator' };
}

function identity(input = {}) {
  const projectId = normalizeProjectId(input.projectId ?? 'orchestrator-pack');
  const repoSlug = normalizeRepoSlug(input.repoSlug);
  const prNumber = Number(input.prNumber);
  const headSha = text(input.headSha ?? input.currentHeadSha).toLowerCase();
  if (!projectId) return { ok: false, reason: 'project_id_invalid' };
  if (!repoSlug) return { ok: false, reason: 'repo_slug_invalid' };
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, reason: 'pr_number_invalid' };
  if (!/^[0-9a-f]{40}$/.test(headSha)) return { ok: false, reason: 'head_sha_invalid' };
  return { ok: true, projectId, repoSlug, prNumber, headSha };
}

export function resolveOperatorMergeApprovalAuthorityStoreRoot(input = {}) {
  const projectId = normalizeProjectId(input.projectId ?? 'orchestrator-pack');
  if (!projectId) throw new Error('invalid operator approval project id');
  const trusted = text(input.operatorApprovalStoreRoot ?? input.storeRoot);
  if (trusted) return path.resolve(trusted);
  const explicit = text(process.env.OPERATOR_MERGE_APPROVAL_STORE_ROOT);
  if (explicit) return path.resolve(explicit);
  return path.join(core.resolveStateRoot(input), 'operator-merge-approvals', projectId);
}

function approvalPath(input, prNumber) {
  return path.join(resolveOperatorMergeApprovalAuthorityStoreRoot(input), `pr-${prNumber}.json`);
}

function readApproval(input = {}) {
  if (input.directOperatorMerge !== true) return { applicable: false, approved: false, reason: 'not_direct_operator_merge' };
  const session = resolveSession();
  if (!session.ok) return { applicable: true, approved: false, reason: session.reason };
  const target = identity(input);
  if (!target.ok) return { applicable: true, approved: false, reason: target.reason };
  const file = approvalPath(input, target.prNumber);
  if (!existsSync(file)) return { applicable: true, approved: false, reason: 'approval_missing' };
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  const revokedAtUtc = text(record.revokedAtUtc);
  const revocationReason = text(record.revocationReason);
  if (
    Number(record.schemaVersion) !== APPROVAL_SCHEMA_VERSION
    || record.event !== APPROVAL_EVENT
    || !text(record.approvalId)
    || !text(record.reason)
    || !text(record.actor)
    || !isIsoUtc(record.createdAtUtc)
    || Boolean(revokedAtUtc) !== Boolean(revocationReason)
    || (revokedAtUtc && !isIsoUtc(revokedAtUtc))
  ) {
    return { applicable: true, approved: false, reason: 'approval_malformed' };
  }
  if (text(record.projectId) !== target.projectId) return { applicable: true, approved: false, reason: 'approval_project_mismatch', record };
  if (text(record.repoSlug) !== target.repoSlug) return { applicable: true, approved: false, reason: 'approval_repository_mismatch', record };
  if (Number(record.prNumber) !== target.prNumber) return { applicable: true, approved: false, reason: 'approval_pr_mismatch', record };
  if (text(record.headSha).toLowerCase() !== target.headSha) return { applicable: true, approved: false, reason: 'approval_head_mismatch', record };
  if (revokedAtUtc) return { applicable: true, approved: false, reason: 'approval_revoked', record };
  return { applicable: true, approved: true, reason: 'approved', record };
}

function packReviewStoreRoot(projectId) {
  const explicit = text(process.env.PACK_REVIEW_RUN_STORE_ROOT);
  if (explicit) return path.resolve(explicit);
  const stateRoot = text(process.env.ORCHESTRATOR_PACK_STATE_ROOT);
  return stateRoot
    ? path.join(path.resolve(stateRoot), 'review-runs', projectId)
    : path.join(homedir(), '.orchestrator-pack', 'review-runs', projectId);
}

function canonicalTerminalStatus(record, findings) {
  const blocking = findings.length > 0
    ? findings.some((finding) => {
        if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return true;
        const severity = text(finding.severity).toLowerCase();
        return severity !== 'warning' && severity !== 'info' && severity !== 'non-blocking';
      })
    : record.reviewVerdict === 'findings';
  if (blocking) return { status: 'changes_requested', requiredReason: 'status_failure' };
  if (record.reviewVerdict === 'clean' && findings.length === 0) {
    return { status: 'up_to_date', requiredReason: 'status_success' };
  }
  return { status: 'commented', requiredReason: 'status_success' };
}

function terminalEvidence(record, target) {
  if (Number(record.schemaVersion) !== 1) return { ok: false, reason: 'schema_version_invalid' };
  const runId = text(record.id ?? record.runId);
  if (!/^prr-[a-zA-Z0-9._-]+$/.test(runId)) return { ok: false, reason: 'run_id_invalid' };
  if (text(record.projectId) !== target.projectId) return { ok: false, reason: 'project_mismatch' };
  if (Number(record.prNumber) !== target.prNumber) return { ok: false, reason: 'pr_mismatch' };
  if (text(record.targetSha ?? record.headSha).toLowerCase() !== target.headSha) return { ok: false, reason: 'head_mismatch' };
  if (text(record.key) !== `pr-${target.prNumber}-${target.headSha}`) return { ok: false, reason: 'key_mismatch' };
  if (record.reviewVerdict !== 'clean' && record.reviewVerdict !== 'findings') return { ok: false, reason: 'verdict_payload_invalid' };
  const findings = Array.isArray(record.findings) ? record.findings : null;
  if (!findings || Number(record.findingCount) !== findings.length) return { ok: false, reason: 'verdict_payload_invalid' };
  const expected = canonicalTerminalStatus(record, findings);
  if (!TERMINAL_STATUSES.has(record.status) || record.latestRunStatus !== record.status || record.status !== expected.status) {
    return { ok: false, reason: 'terminal_status_verdict_mismatch' };
  }
  const completedAtUtc = text(record.completedAtUtc);
  if (!isIsoUtc(completedAtUtc)) return { ok: false, reason: 'completed_timestamp_invalid' };
  const beforeCompletion = (value) => isIsoUtc(value) && Date.parse(value) <= Date.parse(completedAtUtc);
  const journal = record.journalOutcome;
  if (
    journal?.state !== 'persisted'
    || journal.idempotencyKey !== `verdict:${runId}:${target.headSha}`
    || !Number.isInteger(Number(journal.attempts))
    || Number(journal.attempts) <= 0
    || !beforeCompletion(journal.recordedAtUtc)
  ) return { ok: false, reason: 'journal_not_authoritative' };

  const reconciliation = record.githubReviewReconciliation;
  const reviewId = record.githubReviewId ?? reconciliation?.commentReviewId;
  if (
    record.githubReviewEvent !== 'COMMENT'
    || reconciliation?.event !== 'COMMENT'
    || reconciliation.phase !== 'complete'
    || reviewId === undefined
    || !text(reconciliation.actorLogin)
    || !text(reconciliation.commentBody)
    || !Array.isArray(reconciliation.pendingDismissalReviewIds)
    || reconciliation.pendingDismissalReviewIds.length > 0
    || !Array.isArray(reconciliation.dismissedReviewIds)
    || !isIsoUtc(reconciliation.preparedAtUtc)
    || !beforeCompletion(reconciliation.updatedAtUtc)
    || Date.parse(reconciliation.preparedAtUtc) > Date.parse(reconciliation.updatedAtUtc)
  ) return { ok: false, reason: 'github_review_not_authoritative' };
  if (record.githubReviewId !== undefined && reconciliation.commentReviewId !== undefined
    && String(record.githubReviewId) !== String(reconciliation.commentReviewId)) {
    return { ok: false, reason: 'github_review_identity_mismatch' };
  }
  const githubOutcome = record.deliveryOutcomes?.githubComment;
  if (githubOutcome?.state !== 'succeeded'
    || githubOutcome.idempotencyKey !== `github-comment:${runId}:${target.headSha}`
    || !beforeCompletion(githubOutcome.recordedAtUtc)) {
    return { ok: false, reason: 'github_review_delivery_incomplete' };
  }
  const requiredOutcome = record.deliveryOutcomes?.requiredStatus;
  if (requiredOutcome?.state !== 'succeeded'
    || requiredOutcome.reason !== expected.requiredReason
    || requiredOutcome.idempotencyKey !== `required-status:${PACK_REVIEW_CONTEXT}:${target.headSha}`
    || !beforeCompletion(requiredOutcome.recordedAtUtc)) {
    return { ok: false, reason: 'required_status_delivery_incomplete' };
  }
  return {
    ok: true,
    record,
    findings,
    timestampMs: Date.parse(completedAtUtc),
    reviewId: String(reviewId),
    actorLogin: text(reconciliation.actorLogin),
    body: String(reconciliation.commentBody),
  };
}

function latestTerminalReview(target) {
  const dir = path.join(packReviewStoreRoot(target.projectId), 'runs');
  if (!existsSync(dir)) return { ok: false, reason: 'pack_review_store_missing' };
  const accepted = [];
  const rejected = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const record = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'pack_review_store_malformed' };
      if (text(record.projectId) !== target.projectId
        || Number(record.prNumber) !== target.prNumber
        || text(record.targetSha ?? record.headSha).toLowerCase() !== target.headSha) continue;
      const evidence = terminalEvidence(record, target);
      if (evidence.ok) accepted.push(evidence);
      else rejected.push(evidence.reason);
    }
  } catch {
    return { ok: false, reason: 'pack_review_store_malformed' };
  }
  accepted.sort((left, right) => right.timestampMs - left.timestampMs);
  if (accepted.length === 0) return {
    ok: false,
    reason: rejected.length ? 'pack_review_terminal_evidence_missing' : 'pack_review_exact_head_missing',
    evidenceReasons: [...new Set(rejected)],
  };
  return accepted[0];
}

function syntheticHarnessReview(review, target) {
  return {
    id: review.reviewId,
    commitId: target.headSha,
    currentHeadSha: target.headSha,
    state: 'COMMENTED',
    body: review.body,
    submittedAt: null,
    authorLogin: review.actorLogin,
    syntheticHarness: true,
  };
}

function runGh(args, label) {
  const result = runProcessSync({
    command: 'gh',
    args,
    cwd: process.cwd(),
    inheritParentEnv: true,
    encoding: 'utf8',
  });
  if (!result.ok || !text(result.stdout)) {
    throw new Error(`${label}: ${text(result.stderr || result.error || result.stdout || result.outcome)}`);
  }
  return JSON.parse(String(result.stdout));
}

function requireLivePrHead(target) {
  const parsed = runGh([
    'pr', 'view', String(target.prNumber), '--repo', target.repoSlug, '--json', 'headRefOid,headRefName',
  ], 'live PR head read failed');
  const currentHeadSha = text(parsed?.headRefOid).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(currentHeadSha)) throw new Error('live PR head is missing or malformed');
  return currentHeadSha;
}

function liveReview(target, review) {
  const fixture = text(process.env[LIVE_REVIEW_FIXTURE_ENV]);
  if (process.env.OPK_VITEST_HARNESS === '1') {
    if (!fixture) return syntheticHarnessReview(review, target);
    return JSON.parse(readFileSync(path.resolve(fixture), 'utf8'));
  }
  const currentHeadSha = requireLivePrHead(target);
  if (!/^\d+$/.test(review.reviewId)) throw new Error('terminal GitHub review id is not numeric');
  const endpoint = `repos/${target.repoSlug}/pulls/${target.prNumber}/reviews/${review.reviewId}`;
  return {
    ...runGh(['api', endpoint], 'exact GitHub review read failed'),
    currentHeadSha,
  };
}

function verifyLiveReview(target, review) {
  let live;
  try {
    live = liveReview(target, review);
  } catch (error) {
    return { ok: false, reason: 'github_review_live_read_failed', message: error instanceof Error ? error.message : String(error) };
  }
  if (!live || typeof live !== 'object' || Array.isArray(live)) return { ok: false, reason: 'github_review_live_payload_malformed' };
  const reviewId = text(live.id);
  const currentHeadSha = text(live.currentHeadSha).toLowerCase();
  const commitId = text(live.commitId ?? live.commit_id).toLowerCase();
  const state = text(live.state).toUpperCase();
  const actorLogin = text(live.authorLogin ?? live.userLogin ?? live.user?.login);
  const body = String(live.body ?? '');
  if (reviewId !== review.reviewId) return { ok: false, reason: 'github_review_live_identity_mismatch' };
  if (currentHeadSha !== target.headSha) return { ok: false, reason: 'github_review_live_pr_head_mismatch' };
  if (commitId !== target.headSha) return { ok: false, reason: 'github_review_live_head_mismatch' };
  if (state !== 'COMMENTED') return { ok: false, reason: 'github_review_live_state_mismatch' };
  if (actorLogin.toLowerCase() !== review.actorLogin.toLowerCase()) return { ok: false, reason: 'github_review_live_actor_mismatch' };
  if (sha256(body) !== sha256(review.body)) return { ok: false, reason: 'github_review_live_body_mismatch' };
  const runId = text(review.record.id ?? review.record.runId);
  if (live.syntheticHarness !== true
    && (!body.includes(`Run: \`${runId}\``) || !body.includes(`Head: \`${target.headSha}\``))) {
    return { ok: false, reason: 'github_review_live_terminal_binding_missing' };
  }
  const submittedAt = text(live.submittedAt ?? live.submitted_at);
  if (live.syntheticHarness !== true && (!isIsoUtc(submittedAt)
    || Date.parse(submittedAt) > Date.parse(review.record.completedAtUtc))) {
    return { ok: false, reason: 'github_review_live_timestamp_invalid' };
  }
  return {
    ok: true,
    reviewId,
    body,
    bodySha256: sha256(body),
    syntheticHarness: live.syntheticHarness === true,
  };
}

function durableClearanceDecision(input, target, review) {
  const stateRoot = core.resolveStateRoot(input);
  const clearance = path.join(stateRoot, 'merge-triage', 'clearance', `pr-${target.prNumber}-${target.headSha}.json`);
  if (!existsSync(clearance)) return null;
  try {
    const result = core.evaluateMergePolicy({
      stateRoot,
      prNumber: target.prNumber,
      headSha: target.headSha,
      findings: review.findings,
      markerFile: core.DEFAULT_MARKER_FILE,
      atCapRecord: {
        terminal: core.TERMINAL_AT_CAP_OPEN_FINDINGS,
        pr_number: target.prNumber,
        head_sha: target.headSha,
      },
    });
    return result?.allow === true && result.reason === 'merge_triage_cleared' ? result : null;
  } catch {
    return null;
  }
}

export function evaluateDirectOperatorReviewSafety(input = {}) {
  if (input.directOperatorMerge !== true) return { allow: false, reason: 'operator_merge_direct_mode_required' };
  const session = resolveSession();
  if (!session.ok) return { allow: false, reason: 'operator_merge_approval_unavailable', approvalReason: session.reason };
  const target = identity(input);
  if (!target.ok) return { allow: false, reason: 'operator_merge_review_findings_unavailable', reviewReason: target.reason };
  let inbox;
  try {
    inbox = core.readArchitectInbox({ ...input, prNumber: target.prNumber, headSha: target.headSha });
  } catch {
    return { allow: false, reason: 'operator_merge_pending_state_unavailable' };
  }
  if (!inbox || !Array.isArray(inbox.pending)) return { allow: false, reason: 'operator_merge_pending_state_unavailable' };
  if (inbox.pending.length) return { allow: false, reason: 'operator_merge_pending_adjudication', pending: inbox.pending };

  const review = latestTerminalReview(target);
  if (!review.ok) return {
    allow: false,
    reason: 'operator_merge_review_findings_unavailable',
    reviewReason: review.reason,
    ...(review.evidenceReasons ? { evidenceReasons: review.evidenceReasons } : {}),
  };
  const live = verifyLiveReview(target, review);
  if (!live.ok) return {
    allow: false,
    reason: 'operator_merge_github_review_unavailable',
    reviewReason: live.reason,
    ...(live.message ? { message: live.message } : {}),
  };

  const clearance = durableClearanceDecision(input, target, review);
  if (!clearance && review.record.reviewVerdict !== 'clean') {
    const classifications = live.syntheticHarness
      ? review.findings.map((finding) => core.classifyFinding(finding))
      : [core.classifyFinding({
          id: `github-review-${live.reviewId}`,
          fingerprint: live.bodySha256,
          title: 'Live GitHub pack review',
          body: live.body,
        })];
    const block = classifications.filter((classification) => classification.verdict === core.VERDICT_BLOCK);
    if (block.length > 0) return {
      allow: false,
      reason: 'operator_merge_block_findings',
      reviewRunId: text(review.record.id ?? review.record.runId),
      classifications: block,
    };
    const pending = classifications.filter((classification) => (
      classification.verdict === core.VERDICT_PENDING_ARCHITECT
      || classification.verdict === core.VERDICT_PENDING_OPERATOR
    ));
    if (pending.length > 0) return {
      allow: false,
      reason: 'operator_merge_pending_adjudication',
      reviewRunId: text(review.record.id ?? review.record.runId),
      classifications: pending,
    };
  }

  return {
    allow: true,
    reason: 'operator_merge_review_safe',
    reviewRunId: text(review.record.id ?? review.record.runId),
    githubReviewId: live.reviewId,
    githubReviewBodySha256: live.bodySha256,
    ...(clearance ? { canonicalPolicyReason: clearance.reason } : {}),
    ...(review.record.reviewVerdict === 'clean' && review.findings.length > 0 ? { cleanWarningReview: true } : {}),
  };
}

export function evaluateDirectOperatorMergePolicy(input = {}) {
  const approval = readApproval(input);
  if (!approval.applicable) return null;
  if (!approval.approved) return { allow: false, reason: 'operator_merge_approval_unavailable', approvalReason: approval.reason };
  const safety = evaluateDirectOperatorReviewSafety(input);
  if (!safety.allow) return safety;
  return {
    ...safety,
    allow: true,
    reason: 'operator_merge_approved',
    approvalId: approval.record.approvalId,
    approvedHeadSha: approval.record.headSha,
    approvalActor: approval.record.actor,
    approvalReason: approval.record.reason,
  };
}
